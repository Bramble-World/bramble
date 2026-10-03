import { db } from '@/index';
import { NotFoundError, ValidationError } from '@/lib/utils/errors';
import { Generator, getGenerator } from '@/lib/ai';
import { turnPrompt } from '@/lib/ai/prompts/turn.prompt';
import { consequencePrompt } from '@/lib/ai/prompts/consequence.prompt';
import * as sessions from '../sessions/sessions.service';
import * as sessionReader from '../sessions/sessions.reader';
import * as timeline from '../timeline/timeline.service';
import * as timelineReader from '../timeline/timeline.reader';
import * as timelineWriter from '../timeline/timeline.writer';
import { TurnWithChoices } from '../sessions/sessions.types';
import { NewEvent } from '../timeline/timeline.types';
import { assembleSessionContext, assembleStorylineContext } from './context.reader';
import { contextAsOf, scriptExhausted } from './playhead';
import * as sessionWriter from '../sessions/sessions.writer';
import { assertEnergy } from '../sessions/energy.service';
import { ConflictError, StorylineNotReadyError } from '@/lib/utils/errors';
import { surfaceHistoryLine, surfacesFromModel } from '@/lib/surfaces';
import * as storylineReader from '../storylines/storylines.reader';

/** Injected so a test can supply the fake without touching process env. */
/**
 * Injected so a test can supply the fake without touching process env, and so a
 * caller can impose a deadline.
 *
 * `signal` reaches `Generator.run`, which has always accepted one and which
 * nothing ever passed — leaving every generation bounded only by undici's 300s
 * headers timeout, a failure mode with no status code and three automatic
 * retries. See `src/lib/ai/deadline.ts`.
 */
export type GenerationDeps = { generator?: Generator; signal?: AbortSignal };

/**
 * Presents the next beat of a session.
 *
 * Get-or-create on the open turn, and the check happens **before** the model
 * call rather than after: a session has at most one unanswered turn, so if one
 * is already open the right answer is to return it, and paying for a generation
 * first would be spending money to discard the result.
 *
 * Read, generate, write — with no transaction held across the model call. The
 * write is `openTurn`, which is itself a get-or-create, so two callers racing
 * past the first check still produce one turn.
 */
export async function generateTurn(
  userId: string,
  sessionId: string,
  deps: GenerationDeps = {}
): Promise<TurnWithChoices> {
  const session = await sessions.getSession(userId, sessionId);

  const open = await sessionReader.getOpenTurn(db, sessionId);
  if (open) return open;

  // Charged here and nowhere earlier, because here is where a model call becomes
  // necessary. A reader out of energy still gets the turn above for free — being
  // out of energy should not hide the decision already in front of them — and a
  // retry or a concurrent loser, both of which produce nothing, cost nothing.
  await assertEnergy(userId);

  const [storyline, sessionContext] = await Promise.all([
    assembleStorylineContext(userId, session.storylineId),
    assembleSessionContext(userId, sessionId),
  ]);

  const generator = deps.generator ?? getGenerator();
  // The cut happens here rather than inside the prompt's render, so that what
  // the generator is recorded as having been given and what it was actually
  // shown are the same thing. A render that quietly dropped beats would leave
  // the anti-leak test asserting against a context the model never saw.
  const visible = contextAsOf(storyline, session.playheadOrder);
  const { value } = await generator.run(
    turnPrompt,
    {
      storyline: visible,
      session: sessionContext,
      beyondScript: scriptExhausted(storyline, session.playheadOrder),
    },
    { signal: deps.signal }
  );

  return sessions.openTurn(userId, sessionId, {
    headline: value.headline.trim() || null,
    narrativeContent: value.narrative,
    choices: value.choices.map((choice) => ({
      label: choice.label,
      // The schema says nullable because structured output has no absent; the
      // column wants undefined.
      description: choice.description ?? undefined,
    })),
    // Senders are checked against the same cut the model was shown, so a text
    // can only come from someone the reader has already met.
    surfaces: surfacesFromModel(value, visible.characters),
  });
}

/**
 * Records the reader's decision.
 *
 * Deliberately just the write. This is the half the user is waiting on, and it
 * must not be behind a model call: if generation failed afterwards, their answer
 * would be lost with it. `generateConsequences` is the other half and runs
 * separately, which also means a failure between the two is a resumable state
 * rather than corruption — the turn is answered and simply has no consequences
 * yet, which is a queryable condition.
 */
export async function commitChoice(
  userId: string,
  turnId: string,
  choiceId: string
): Promise<TurnWithChoices> {
  return sessions.answerTurn(userId, turnId, choiceId);
}

export type Consequences = {
  events: number;
  contextEntries: number;
  relationshipStates: number;
};

/**
 * Works out what a decision changed, and writes it to canon.
 *
 * Idempotent through `events.triggeredByTurnId`, which is the lineage column
 * rather than a bookkeeping table invented for the purpose: if a beat already
 * points at this turn, the work is done and a retry neither pays for a second
 * generation nor appends a duplicate.
 *
 * Everything the model returns commits in one transaction. Half-written
 * consequences — a beat with no relationship state, or backstory attached to a
 * beat that never landed — would read as perfectly valid rows.
 */
export async function generateConsequences(
  userId: string,
  turnId: string,
  deps: GenerationDeps = {}
): Promise<Consequences> {
  const empty: Consequences = { events: 0, contextEntries: 0, relationshipStates: 0 };

  const turn = await sessionReader.getTurn(db, turnId);
  if (!turn) throw new NotFoundError('Turn', turnId);

  // Ownership, before anything is spent. getSession is scoped to the user.
  const session = await sessions.getSession(userId, turn.sessionId);

  if (!turn.selectedChoiceId) {
    throw new ValidationError('This turn has not been answered yet');
  }
  // Cheap pre-check, so a retry of an already-resolved turn costs one SELECT
  // rather than a model call. It is not the guard — the claim inside the
  // transaction is, because this read and that write are seconds apart.
  if (await sessionReader.turnHasResolvedConsequences(db, turnId)) return empty;

  // Counted here, before the work, and on `db` rather than in a transaction:
  // everything below either commits together or rolls back together, so a
  // counter written inside that boundary would be undone by the very failure it
  // exists to count. Placed above context assembly as well as the model call,
  // because both are pure functions of stored state and both can fail the same
  // way every time.
  await sessionWriter.recordConsequenceAttempt(db, turnId);

  // Deliberately the WHOLE timeline, unlike generateTurn. This stage is
  // reasoning about what a decision changed, which needs the story entire; and
  // narrowing it here would also shrink what `recordRelationshipState` can
  // legally attach to. Do not wrap this in contextAsOf.
  const storyline = await assembleStorylineContext(userId, session.storylineId);

  const chosen = turn.choices.find((choice) => choice.id === turn.selectedChoiceId);
  if (!chosen) throw new ValidationError('The recorded choice is not one this turn offered');

  const generator = deps.generator ?? getGenerator();
  const { value } = await generator.run(
    consequencePrompt,
    {
      storyline,
      decision: {
        headline: turn.headline,
        narrativeContent: turn.narrativeContent,
        surfaceLines: turn.surfaces.map(surfaceHistoryLine),
        chosenLabel: chosen.label,
        chosenDescription: chosen.description,
        rejectedLabels: turn.choices.filter((c) => c.id !== chosen.id).map((c) => c.label),
      },
    },
    { signal: deps.signal }
  );

  // Consequences land where the reader is, not where a model guesses. Asked for
  // a position, it used to pick one well behind the narration — anchoring at
  // 1500-3500 in a session that had reached 6000 — which files the result of a
  // decision above or below the only place the reader can see it.
  const anchor = session.playheadOrder;

  const characterIds = new Set(storyline.characters.map((c) => c.id));
  const relationshipIds = new Set(storyline.relationships.map((r) => r.id));

  const events: NewEvent[] = value.events.map((event) => ({
    origin: 'conversation_generated',
    triggeredByTurnId: turnId,
    generationRationale: event.generationRationale,
    title: event.title,
    description: event.description,
    stakes: event.stakes ?? undefined,
    // Silently dropped rather than rejected: a hallucinated id should not throw
    // away a whole beat, and the timeline service would refuse the write anyway.
    participantCharacterIds: event.participantCharacterIds.filter((id) => characterIds.has(id)),
    // Same treatment for the same reason. Recorded for measurement only — no
    // prompt reads it, because feeding it back would turn "who acts" into a
    // rota, which is the formula this exists to escape.
    actorCharacterId:
      event.actorCharacterId && characterIds.has(event.actorCharacterId)
        ? event.actorCharacterId
        : undefined,
    engagementScore: event.engagementScore,
  }));

  return db.transaction(async (tx) => {
    // The real guard, and the first thing in the transaction. A generation that
    // ran while another caller was already committing must write nothing at
    // all — a second set of beats for one decision is worse than a wasted call.
    if (!(await sessionWriter.claimConsequences(tx, turnId))) return empty;

    const written = await insertAtOrAfter(tx, session.storylineId, anchor, events);

    for (const entry of value.contextEntries) {
      await timelineWriter.insertContextEntry(tx, session.storylineId, {
        source: 'conversation_generated',
        triggeredByTurnId: turnId,
        content: entry.content,
        characterId:
          entry.characterId && characterIds.has(entry.characterId) ? entry.characterId : undefined,
      });
    }

    // A relationship state has to attach to an event, since it records what that
    // beat changed. With no new beat there is nothing to attach to, and a state
    // floating free of a cause is exactly what the schema refuses to express.
    const anchorEvent = written[0];
    let states = 0;
    if (anchorEvent) {
      for (const state of value.relationshipStates) {
        if (!relationshipIds.has(state.relationshipId)) continue;
        await timeline.recordRelationshipState(
          {
            relationshipId: state.relationshipId,
            eventId: anchorEvent.id,
            dynamic: {
              closeness: state.closeness ?? undefined,
              tension: state.tension ?? undefined,
              powerBalance: state.powerBalance ?? undefined,
            },
          },
          tx
        );
        states += 1;
      }
    }

    // The reader has to be able to see what their own choice caused, so the
    // playhead covers it. A raise, not a set: this function is safe to retry.
    const reached = written.at(-1)?.narrativeOrder;
    if (reached !== undefined) {
      await sessionWriter.raisePlayheadTo(tx, session.id, reached);
    }

    return {
      events: written.length,
      contextEntries: value.contextEntries.length,
      relationshipStates: states,
    };
  });
}

/**
 * Inserts after `anchor`, falling back to the end of the timeline.
 *
 * `gapOrderAfter` midpoints into the space above the anchor and gives up when
 * two beats are already adjacent, which `insertEventsAfterIn` reports as a
 * ConflictError. That is the right answer for a caller that must land in a
 * specific place, and the wrong one here: losing a reader's consequence because
 * one region of the timeline is crowded trades a real beat for a tidy invariant.
 *
 * Appending instead puts it slightly later than the decision strictly warrants,
 * which is a far smaller lie than dropping it.
 */
async function insertAtOrAfter(
  tx: Parameters<typeof timeline.insertEventsAfterIn>[0],
  storylineId: string,
  anchor: number,
  events: NewEvent[]
) {
  try {
    return await timeline.insertEventsAfterIn(tx, storylineId, anchor, events);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const last = await timelineReader.nextNarrativeOrder(tx, storylineId);
    return timeline.insertEventsAfterIn(tx, storylineId, last, events);
  }
}

/**
 * Brings a session to a playable state and returns what to show.
 *
 * The whole client-facing loop is this one operation, and that is the point.
 * Consequences must be written before the next turn is generated — the turn
 * prompt reads the canon they write — and publishing that as three ordered calls
 * would make correctness depend on a shipped binary doing three things in the
 * right order. A client that skipped the middle one, through a bug, an old build
 * or a crash, would generate every later turn against stale canon: no error
 * anywhere, just quality quietly decaying.
 *
 * Defined convergently rather than as a sequence, so the same call is the loop,
 * the resume and the retry. Whatever is owed gets settled, then a turn is
 * produced. Calling it twice is safe: `generateConsequences` is claimed
 * transactionally and `generateTurn` is get-or-create behind the one-open-turn
 * index, so a second call finds the work done and costs a SELECT.
 *
 * Failing the whole thing when a consequence fails is deliberate. Skipping ahead
 * would produce a turn built on canon that is missing the reader's last decision
 * — a regression with nothing to report it.
 */
/**
 * How many times one turn's consequences may be attempted before we give up.
 *
 * Above the client's own retry policy, which is three with jittered backoff and
 * then a button. A provider blip that outlasts that burst should not cost the
 * story a beat, so the budget leaves room for the reader to press the button
 * twice more before anything is abandoned.
 *
 * Every failure counts, including our own 60s deadline. Exempting timeouts would
 * mean a storyline whose context reliably outruns the deadline still wedges
 * forever, which is the bug rather than a refinement of it. The price is a
 * reader who backgrounds the app mid-generation five times on the same turn and
 * loses one beat of canon — worth it against a session that can never move
 * again.
 */
export const CONSEQUENCE_ATTEMPT_BUDGET = 5;

export async function advanceSession(
  userId: string,
  sessionId: string,
  deps: GenerationDeps = {}
): Promise<TurnWithChoices> {
  const session = await sessions.getSession(userId, sessionId);

  // Re-checked here, not just at startSession: a storyline can fail after a
  // session has begun, and nothing would otherwise notice.
  const storyline = await storylineReader.getStoryline(userId, session.storylineId);
  if (!storyline) throw new NotFoundError('Storyline', session.storylineId);
  if (storyline.status !== 'ready') throw new StorylineNotReadyError(storyline.status);

  // Asked before settling, and only when a new turn is actually needed. Settling
  // a consequence costs a model call, so discovering the reader is out of energy
  // afterwards would spend money and then refuse them. `generateTurn` checks
  // again and is the authority; this only moves the refusal in front of the
  // spend.
  //
  // Consequences themselves are free. They are owed work from a turn already
  // paid for, so one point buys "settle what is owed, then give me the next
  // beat" — which is what this function means. Charging again would bill a
  // reader twice for one beat because their first attempt failed.
  if (!(await sessionReader.getOpenTurn(db, sessionId))) {
    await assertEnergy(userId);
  }

  // Oldest first. Each one's beats are canon for the turn after it, so settling
  // them out of order would build later beats on earlier gaps.
  const owed = await sessionReader.findTurnsOwedConsequences(db, sessionId);
  for (const turn of owed) {
    try {
      await generateConsequences(userId, turn.id, deps);
    } catch (error) {
      // Budget left: fail the whole call, exactly as before. Skipping ahead
      // would build the next beat on canon missing the reader's last decision —
      // a silent quality regression with nothing to report it — and most
      // failures here are transient and clear on the next try.
      if ((await sessionReader.consequenceAttempts(db, turn.id)) < CONSEQUENCE_ATTEMPT_BUDGET) {
        throw error;
      }

      // Budget gone. Stamp it and carry on in the same request, so the tap that
      // exhausts the budget is the one that gets a turn back rather than a fifth
      // identical error.
      await sessionWriter.abandonConsequences(db, turn.id);
    }
  }

  return generateTurn(userId, sessionId, deps);
}
