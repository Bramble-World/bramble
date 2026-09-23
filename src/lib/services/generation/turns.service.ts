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

/** Injected so a test can supply the fake without touching process env. */
export type GenerationDeps = { generator?: Generator };

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

  const [storyline, sessionContext] = await Promise.all([
    assembleStorylineContext(userId, session.storylineId),
    assembleSessionContext(userId, sessionId),
  ]);

  const generator = deps.generator ?? getGenerator();
  const { value } = await generator.run(turnPrompt, { storyline, session: sessionContext });

  return sessions.openTurn(
    userId,
    sessionId,
    value.narrative,
    value.choices.map((choice) => ({
      label: choice.label,
      // The schema says nullable because structured output has no absent; the
      // column wants undefined.
      description: choice.description ?? undefined,
    }))
  );
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
  if (await timelineReader.turnHasConsequences(db, turnId)) return empty;

  const storyline = await assembleStorylineContext(userId, session.storylineId);

  const chosen = turn.choices.find((choice) => choice.id === turn.selectedChoiceId);
  if (!chosen) throw new ValidationError('The recorded choice is not one this turn offered');

  const generator = deps.generator ?? getGenerator();
  const { value } = await generator.run(consequencePrompt, {
    storyline,
    decision: {
      narrativeContent: turn.narrativeContent,
      chosenLabel: chosen.label,
      chosenDescription: chosen.description,
      rejectedLabels: turn.choices.filter((c) => c.id !== chosen.id).map((c) => c.label),
    },
  });

  // A model is free to name a beat that does not exist, so the anchor is snapped
  // to a real one rather than trusted. 0 means "before everything", which
  // gapOrderAfter handles as the empty-timeline case.
  const orders = new Set(storyline.timeline.map((beat) => beat.narrativeOrder));
  const anchor = orders.has(value.afterNarrativeOrder)
    ? value.afterNarrativeOrder
    : (storyline.timeline.at(-1)?.narrativeOrder ?? 0);

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
  }));

  return db.transaction(async (tx) => {
    const written = await timeline.insertEventsAfterIn(tx, session.storylineId, anchor, events);

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

    return {
      events: written.length,
      contextEntries: value.contextEntries.length,
      relationshipStates: states,
    };
  });
}
