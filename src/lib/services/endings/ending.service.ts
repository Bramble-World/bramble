import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/index';
import { storylineSessions } from '@/db/schema/tables';
import { Generator, getGenerator } from '@/lib/ai';
import { endingPrompt } from '@/lib/ai/prompts/ending.prompt';
import type { StoredEnding } from '@/lib/endings/ending';
import { GenerationUnusableError } from '@/lib/utils/errors';
import { assembleSessionContext, assembleStorylineContext } from '../generation/context.reader';
import { contextAsOf } from '../generation/playhead';
import * as sessions from '../sessions/sessions.service';
import * as sessionReader from '../sessions/sessions.reader';

/**
 * Writes the ending page for a finished story, once.
 *
 * Runs after the ending turn's response is sent (`after()` in the turn route),
 * and again from any later `POST .../turn` on the ended session until it has
 * succeeded — so a failure costs nothing but a retry. A no-op for a story still
 * going, or one whose ending is already written.
 *
 * The model is shown this playthrough only, and the people the reader met, so
 * the page cannot describe a beat the reader hasn't lived.
 */
export async function writeEnding(
  userId: string,
  sessionId: string,
  deps: { generator?: Generator; signal?: AbortSignal } = {}
): Promise<StoredEnding | null> {
  const session = await sessions.getSession(userId, sessionId);
  if (!session.endedAt) return null;
  const existing = await storedEnding(sessionId);
  if (existing) return existing;

  const [storyline, played, answered] = await Promise.all([
    assembleStorylineContext(userId, session.storylineId),
    assembleSessionContext(userId, sessionId),
    sessionReader.listAnsweredTurns(db, sessionId),
  ]);
  const people = contextAsOf(storyline, session.playheadOrder)
    .characters.filter((character) => !character.isSelf)
    .map((character) => character.name);

  const generator = deps.generator ?? getGenerator();
  const { value } = await generator.run(
    endingPrompt,
    { title: storyline.storyline.title, tone: storyline.storyline.tone, people, session: played },
    { signal: deps.signal }
  );

  // Beat numbers are positions in the playthrough. Only beats that were
  // answered can be a choice; anything else the model named is dropped, and
  // each beat counts once.
  const byBeat = new Map(played.turns.map((turn, i) => [i + 1, turn.turnOrder]));
  const answeredByOrder = new Map(answered.map((turn) => [turn.turnOrder, turn.id]));
  const seen = new Set<string>();
  const keyChoices = value.keyChoices.flatMap((choice) => {
    const order = byBeat.get(choice.beat);
    const turnId = order === undefined ? undefined : answeredByOrder.get(order);
    if (!turnId || seen.has(turnId)) return [];
    seen.add(turnId);
    return [{ turnId, label: choice.label.trim() }];
  });
  if (keyChoices.length === 0) {
    throw new GenerationUnusableError('The ending named no choice the reader made');
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

export async function storedEnding(sessionId: string): Promise<StoredEnding | null> {
  const [row] = await db
    .select({ ending: storylineSessions.ending })
    .from(storylineSessions)
    .where(eq(storylineSessions.id, sessionId));
  return row?.ending ?? null;
}
