import { contextEntries, eventParticipants, events, relationshipStates } from '@/db/schema/tables';
import { Executor } from '../executor';
import {
  NewContextEntry,
  NewEvent,
  NewRelationshipState,
  PublicContextEntry,
  PublicEvent,
} from './timeline.types';

const returnedEvent = {
  id: events.id,
  storylineId: events.storylineId,
  narrativeOrder: events.narrativeOrder,
  occurredAt: events.occurredAt,
  title: events.title,
  description: events.description,
  stakes: events.stakes,
  origin: events.origin,
  triggeredByTurnId: events.triggeredByTurnId,
  generationRationale: events.generationRationale,
};

/**
 * Writes a beat and its participants.
 *
 * Takes an `Executor` so it can join the caller's transaction: the beat and the
 * characters present at it are one fact, and a beat that committed without its
 * participants would read as a scene nobody was in.
 *
 * The conditional columns are derived from the discriminated union rather than
 * accepted as free-standing fields, so `triggeredByTurnId` is present exactly
 * when `origin` is `conversation_generated` and null otherwise. There is no
 * argument shape that produces the wrong pairing.
 */
export async function insertEvent(
  tx: Executor,
  storylineId: string,
  narrativeOrder: number,
  input: NewEvent
): Promise<PublicEvent> {
  const generated = input.origin === 'conversation_generated';

  const [event] = await tx
    .insert(events)
    .values({
      storylineId,
      narrativeOrder,
      title: input.title,
      description: input.description,
      stakes: input.stakes,
      occurredAt: input.occurredAt,
      origin: input.origin,
      triggeredByTurnId: generated ? input.triggeredByTurnId : null,
      generationRationale: generated ? input.generationRationale : null,
    })
    .returning(returnedEvent);

  const participants = input.participantCharacterIds ?? [];
  if (participants.length > 0) {
    await tx
      .insert(eventParticipants)
      .values(participants.map((characterId) => ({ eventId: event.id, characterId })))
      .onConflictDoNothing();
  }

  return event;
}

export async function insertContextEntry(
  tx: Executor,
  storylineId: string,
  input: NewContextEntry
): Promise<PublicContextEntry> {
  const [entry] = await tx
    .insert(contextEntries)
    .values({
      storylineId,
      characterId: input.characterId,
      content: input.content,
      source: input.source,
      // Same conditional-column rule as events, same union treatment.
      triggeredByTurnId: input.source === 'conversation_generated' ? input.triggeredByTurnId : null,
    })
    .returning({
      id: contextEntries.id,
      storylineId: contextEntries.storylineId,
      characterId: contextEntries.characterId,
      content: contextEntries.content,
      source: contextEntries.source,
      triggeredByTurnId: contextEntries.triggeredByTurnId,
    });

  return entry;
}

export async function insertRelationshipState(
  tx: Executor,
  input: NewRelationshipState
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(relationshipStates)
    .values(input)
    .returning({ id: relationshipStates.id });
  return row;
}
