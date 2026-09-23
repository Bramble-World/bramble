import { db } from '@/index';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as storylineReader from '../storylines/storylines.reader';
import { Executor } from '../executor';
import * as reader from './timeline.reader';
import * as writer from './timeline.writer';
import {
  NewContextEntry,
  NewEvent,
  NewRelationshipState,
  PublicContextEntry,
  PublicEvent,
} from './timeline.types';

export const listTimeline = reader.listTimeline;

/**
 * Appends a beat to the end of a storyline's timeline.
 *
 * The narrative order is allocated **inside** the transaction, behind a row lock
 * on the storyline, because allocating it is a read-then-write: two concurrent
 * appends otherwise read the same maximum and pick the same slot. Since PR #23
 * that is a unique-index violation rather than silent corruption, so the lock
 * exists to turn a loud failure into a short wait.
 *
 * Participants are verified to belong to this storyline first. invariants.md §3
 * lists "a character credited in a story they aren't in" — `eventParticipants`
 * has single-column keys to both sides and relates them to nothing.
 */
export async function appendEvent(
  userId: string,
  storylineId: string,
  input: NewEvent
): Promise<PublicEvent> {
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  return db.transaction(async (tx) => {
    await reader.lockStorylineForOrdering(tx, storylineId);
    await assertParticipantsBelong(tx, storylineId, input.participantCharacterIds);
    const narrativeOrder = await reader.nextNarrativeOrder(tx, storylineId);
    return writer.insertEvent(tx, storylineId, narrativeOrder, input);
  });
}

/**
 * Inserts a beat between an existing one and whatever follows it.
 *
 * This is how a decision adds to canon: the consequence belongs where the story
 * was, not appended after everything that came later. Gap numbering (invariants
 * §6) is what makes that possible without renumbering the rest.
 */
export async function insertEventAfter(
  userId: string,
  storylineId: string,
  afterNarrativeOrder: number,
  input: NewEvent
): Promise<PublicEvent> {
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  return db.transaction(async (tx) => {
    await reader.lockStorylineForOrdering(tx, storylineId);
    await assertParticipantsBelong(tx, storylineId, input.participantCharacterIds);

    const narrativeOrder = await reader.gapOrderAfter(tx, storylineId, afterNarrativeOrder);
    if (narrativeOrder === null) {
      // Adjacent integers with nothing between them. Surfaced rather than
      // rounded into a value already taken, which the unique index would reject
      // anyway but with a far less useful message.
      throw new ConflictError(
        `No narrative order is free after ${afterNarrativeOrder}; the timeline needs renumbering`
      );
    }

    return writer.insertEvent(tx, storylineId, narrativeOrder, input);
  });
}

export async function addContextEntry(
  userId: string,
  storylineId: string,
  input: NewContextEntry
): Promise<PublicContextEntry> {
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  if (input.characterId) {
    const owned = await reader.charactersInStoryline(db, storylineId, [input.characterId]);
    if (owned.size !== 1) {
      throw new ValidationError('That character belongs to a different storyline');
    }
  }

  return writer.insertContextEntry(db, storylineId, input);
}

/**
 * Records how a relationship stands after a particular beat.
 *
 * The relationship and the event must share a storyline. Nothing enforces it —
 * invariants.md §3 calls the failure "a state change attributed to an unrelated
 * story's event", and the result is a relationship history that silently
 * interleaves two stories.
 */
export async function recordRelationshipState(
  input: NewRelationshipState,
  tx: Executor = db
): Promise<{ id: string }> {
  const { relationship, event } = await reader.storylinesOf(
    tx,
    input.relationshipId,
    input.eventId
  );

  if (!relationship) throw new NotFoundError('Relationship', input.relationshipId);
  if (!event) throw new NotFoundError('Event', input.eventId);
  if (relationship !== event) {
    throw new ValidationError('The relationship and the event belong to different storylines');
  }

  return writer.insertRelationshipState(tx, input);
}

async function assertParticipantsBelong(
  tx: Executor,
  storylineId: string,
  characterIds: string[] | undefined
): Promise<void> {
  const ids = [...new Set(characterIds ?? [])];
  if (ids.length === 0) return;

  const present = await reader.charactersInStoryline(tx, storylineId, ids);
  if (present.size !== ids.length) {
    throw new ValidationError('Every participant must be a character in this storyline');
  }
}
