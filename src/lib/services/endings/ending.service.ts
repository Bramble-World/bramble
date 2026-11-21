import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/index';
import { storylineSessions } from '@/db/schema/tables';
import { Generator, getGenerator } from '@/lib/ai';
import { withDeadline } from '@/lib/ai/deadline';
import { failureFields } from '@/lib/ai/failure';
import { endingPrompt, type EndingOutput } from '@/lib/ai/prompts/ending.prompt';
import type { StoredEnding } from '@/lib/endings/ending';
import {
  AppError,
  GenerationFailedError,
  GenerationTimeoutError,
  UpstreamBusyError,
} from '@/lib/utils/errors';
import { assembleSessionContext, assembleStorylineContext } from '../generation/context.reader';
import { contextAsOf } from '../generation/playhead';
import * as sessions from '../sessions/sessions.service';
import * as sessionReader from '../sessions/sessions.reader';
import type { TurnWithChoices } from '../sessions/sessions.types';
import { relationshipToReader } from '@/lib/ai/prompts/relationship';

/**
 * How many times an ending is attempted in all, across the turn that ended the
 * story, reads of the session and the sweep. Past it nothing tries again, and
 * the session says so (`endingStatus: 'unavailable'`).
 */
export const ENDING_MAX_ATTEMPTS = 5;

/**
 * How long a claimed attempt holds the session before another may start.
 *
 * The lease, and with it the backoff between attempts: the app re-reads an
 * ended session every 2 s while it waits, and each read would otherwise start
 * a model call. Longer than one attempt can take (two tries of
 * `ENDING_DEADLINE_MS` and the pause between them), so an attempt still
 * running is never overtaken by the next.
 */
export const ENDING_LEASE_MS = 2 * 60_000;

/** One model call's deadline. An ending is two sentences and three labels. */
const ENDING_DEADLINE_MS = 50_000;

/** The pause before trying a transient failure again, inside one attempt. */
const RETRY_DELAY_MS = 500;

/** What started an attempt, for the failure log. */
export type EndingTrigger = 'turn' | 'read' | 'sweep';

/**
 * Where an ended session's ending page stands.
 *
 * - `ready`: written.
 * - `writing`: not yet, and an attempt is running or still to come.
 * - `unavailable`: every attempt failed. Nothing more will be tried, so the
 *   app should stop waiting for it and move the reader on.
 */
export type EndingStatus = 'ready' | 'writing' | 'unavailable';

/** The ending columns of one session. */
export type EndingRecord = {
  ending: StoredEnding | null;
  attempts: number;
  attemptedAt: Date | null;
};

const leaseHeld = (record: EndingRecord, now: Date) =>
  record.attemptedAt !== null && now.getTime() - record.attemptedAt.getTime() < ENDING_LEASE_MS;

/**
 * Whether an attempt may start now: no ending, under the cap, and none in the
 * last `ENDING_LEASE_MS`. A cheap pre-check for a read; the claim itself is
 * the conditional UPDATE in `claimEndingAttempt`, which is what holds across
 * pods.
 */
export function mayAttemptEnding(record: EndingRecord, now = new Date()): boolean {
  return record.ending === null && record.attempts < ENDING_MAX_ATTEMPTS && !leaseHeld(record, now);
}

export function endingStatus(record: EndingRecord, now = new Date()): EndingStatus {
  if (record.ending) return 'ready';
  // The last attempt may still be running: it isn't over until its lease is.
  if (record.attempts >= ENDING_MAX_ATTEMPTS && !leaseHeld(record, now)) return 'unavailable';
  return 'writing';
}

export async function endingRecord(sessionId: string): Promise<EndingRecord> {
  const [row] = await db
    .select({
      ending: storylineSessions.ending,
      attempts: storylineSessions.endingAttempts,
      attemptedAt: storylineSessions.endingAttemptedAt,
    })
    .from(storylineSessions)
    .where(eq(storylineSessions.id, sessionId));
  return {
    ending: row?.ending ?? null,
    attempts: row?.attempts ?? 0,
    attemptedAt: row?.attemptedAt ?? null,
  };
}

/**
 * Claims the next attempt at this session's ending, or null when it isn't
 * this caller's to make: written already, at the cap, or attempted within the
 * lease. One conditional UPDATE, judged by the database's clock, so two pods
 * (or a pod and the sweep) reading the same session at once start one model
 * call between them.
 */
export async function claimEndingAttempt(sessionId: string): Promise<number | null> {
  const leaseStart = sql`now() - make_interval(secs => ${ENDING_LEASE_MS / 1000})`;
  const [claimed] = await db
    .update(storylineSessions)
    .set({
      endingAttempts: sql`${storylineSessions.endingAttempts} + 1`,
      endingAttemptedAt: sql`now()`,
    })
    .where(
      and(
        eq(storylineSessions.id, sessionId),
        isNotNull(storylineSessions.endedAt),
        isNull(storylineSessions.ending),
        lt(storylineSessions.endingAttempts, ENDING_MAX_ATTEMPTS),
        or(
          isNull(storylineSessions.endingAttemptedAt),
          lt(storylineSessions.endingAttemptedAt, leaseStart)
        )
      )
    )
    .returning({ attempt: storylineSessions.endingAttempts });
  return claimed?.attempt ?? null;
}

/**
 * Writes the ending page for a finished story, once.
 *
 * Started after the ending turn's response is sent (`after()` in the turn
 * route), again by any read of the ended session while it's missing, and by the
 * ending sweep for anything those missed (a pod restarted mid-write, a reader
 * who never came back). Each start claims an attempt first, so they never
 * overlap and never pass `ENDING_MAX_ATTEMPTS`; a caller that doesn't get the
 * claim gets whatever is stored, possibly null. A no-op for a story still
 * going, or one whose ending is already written.
 *
 * The model is shown this playthrough only, and the people the reader met, so
 * the page cannot describe a beat the reader hasn't lived.
 *
 * A failure is logged here (`ending_write_failed`, ids and the error's code
 * only) and rethrown.
 */
export async function writeEnding(
  userId: string,
  sessionId: string,
  deps: { generator?: Generator; trigger?: EndingTrigger } = {}
): Promise<StoredEnding | null> {
  const session = await sessions.getSession(userId, sessionId);
  if (!session.endedAt) return null;
  const existing = await storedEnding(sessionId);
  if (existing) return existing;

  const attempt = await claimEndingAttempt(sessionId);
  if (attempt === null) return storedEnding(sessionId);

  try {
    return await composeEnding(userId, sessionId, session, deps.generator ?? getGenerator());
  } catch (error) {
    // The code, never the message: a generation error can carry the playthrough.
    console.log(
      JSON.stringify({
        event: 'ending_write_failed',
        sessionId,
        attempt,
        trigger: deps.trigger ?? 'turn',
        ...failureKind(error),
      })
    );
    throw error;
  }
}

async function composeEnding(
  userId: string,
  sessionId: string,
  session: { storylineId: string; playheadOrder: number },
  generator: Generator
): Promise<StoredEnding> {
  const [storyline, played, answered] = await Promise.all([
    assembleStorylineContext(userId, session.storylineId),
    assembleSessionContext(userId, sessionId),
    sessionReader.listAnsweredTurns(db, sessionId),
  ]);
  const reached = contextAsOf(storyline, session.playheadOrder);
  const people = reached.characters
    .filter((character) => !character.isSelf)
    .map((character) => character.name);
  const toYou = reached.relationships
    .map((relationship) => relationshipToReader(reached, relationship))
    .filter((line) => line !== null);

  const vars = {
    title: storyline.storyline.title,
    tone: storyline.storyline.tone,
    people,
    toYou,
    session: played,
  };
  const value = await onceMoreIfTransient(async () => {
    const { value } = await withDeadline(
      (signal) => generator.run(endingPrompt, vars, { signal }),
      ENDING_DEADLINE_MS
    );
    return value;
  });

  const { keyChoices, fellBack } = keyChoicesFor(
    value.keyChoices,
    played.turns.map((turn) => turn.turnOrder),
    answered
  );
  if (fellBack) {
    // Counts only: how often the model's beat numbers miss, without the story.
    console.log(
      JSON.stringify({
        event: 'ending_key_choices_fell_back',
        sessionId,
        named: value.keyChoices.length,
        answered: answered.length,
      })
    );
  }

  const ending: StoredEnding = {
    title: value.title.trim(),
    summary: value.summary.trim(),
    keyChoices,
    storyNights: value.storyNights,
    peopleMet: people,
  };

  // Written once: a concurrent writer that got there first wins.
  await db
    .update(storylineSessions)
    .set({ ending })
    .where(
      and(
        eq(storylineSessions.id, sessionId),
        isNotNull(storylineSessions.endedAt),
        isNull(storylineSessions.ending)
      )
    );
  return (await storedEnding(sessionId)) ?? ending;
}

/**
 * The key choices to keep from what the model named.
 *
 * Beat numbers are positions in the playthrough. Only beats that were answered
 * can be a choice; anything else the model named is dropped, and each beat
 * counts once. When none of them is a real choice the page is still worth
 * having, so rather than throw the whole ending away it falls back to the
 * reader's own choices, as they tapped them: up to three, spread across the
 * story from its first to its last. Story order either way.
 */
export function keyChoicesFor(
  named: EndingOutput['keyChoices'],
  beatOrders: number[],
  answered: TurnWithChoices[]
): { keyChoices: StoredEnding['keyChoices']; fellBack: boolean } {
  const orderOf = new Map(beatOrders.map((order, i) => [i + 1, order]));
  const answeredByOrder = new Map(answered.map((turn) => [turn.turnOrder, turn]));
  const seen = new Set<string>();
  const kept = named.flatMap((choice) => {
    const order = orderOf.get(choice.beat);
    const turn = order === undefined ? undefined : answeredByOrder.get(order);
    const label = choice.label.trim();
    if (!turn || !label || seen.has(turn.id)) return [];
    seen.add(turn.id);
    return [{ turn, label }];
  });
  if (kept.length) {
    return {
      keyChoices: kept
        .sort((a, b) => a.turn.turnOrder - b.turn.turnOrder)
        .map(({ turn, label }) => ({ turnId: turn.id, label })),
      fellBack: false,
    };
  }

  const picked = spread(answered, 3);
  return {
    keyChoices: picked.flatMap((turn) => {
      const chosen = turn.choices.find((choice) => choice.id === turn.selectedChoiceId);
      const label = chosen?.label.trim();
      if (!label) return [];
      // The page is lowercase; the label's first word is a button's capital.
      return [{ turnId: turn.id, label: label.charAt(0).toLowerCase() + label.slice(1) }];
    }),
    fellBack: true,
  };
}

/** Up to `n` items, evenly spaced from the first to the last, in order. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const indices = new Set(
    Array.from({ length: n }, (_, k) => Math.round((k * (items.length - 1)) / (n - 1)))
  );
  return [...indices].map((i) => items[i]);
}

/**
 * One more try when the provider failed in a way that might not happen twice:
 * our deadline, the provider throttling us, a server error or a dropped
 * connection. Not a 4xx, nor output that didn't match the schema, which would
 * fail the same way again.
 */
async function onceMoreIfTransient<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isTransient(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return run();
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof GenerationTimeoutError || error instanceof UpstreamBusyError) return true;
  if (!(error instanceof GenerationFailedError)) return false;
  const { status } = failureFields(error.cause);
  return status === undefined || status >= 500;
}

/** An error as fixed fields: our code (or the class), and the provider's status if any. */
function failureKind(error: unknown): { error: string; status?: number } {
  const kind =
    error instanceof AppError ? error.code : error instanceof Error ? error.name : 'unknown';
  const { status } = error instanceof AppError ? failureFields(error.cause) : {};
  return status === undefined ? { error: kind } : { error: kind, status };
}

export async function storedEnding(sessionId: string): Promise<StoredEnding | null> {
  return (await endingRecord(sessionId)).ending;
}
