import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as personReader from '../persons/persons.reader';
import * as storylineReader from '../storylines/storylines.reader';
import * as reader from './motifs.reader';
import * as writer from './motifs.writer';
import { NewMotif, PublicMotif } from './motifs.types';

export const listMotifs = reader.listMotifs;

/**
 * Creates a motif — a running joke, a callback, a recurring reference.
 *
 * Motifs belong to the **user**, not to any one storyline, because a running
 * joke belongs to the people it is about rather than to one story about them.
 * Its participants are therefore `persons`, and every one of them is verified to
 * belong to the same user first: `motifParticipants` has a single-column foreign
 * key to `persons` and no idea whose motif it is attached to.
 */
export async function createMotif(
  userId: string,
  input: NewMotif,
  personIds: string[] = []
): Promise<PublicMotif> {
  if (!input.label.trim()) {
    throw new ValidationError('A motif needs a label', { label: 'must not be empty' });
  }

  const unique = [...new Set(personIds)];
  if (unique.length > 0) {
    const owned = await personReader.ownedPersonIds(userId, unique);
    if (owned.size !== unique.length) throw new NotFoundError('Person');
  }

  return writer.insertMotif(userId, input, unique);
}

/**
 * Records that a motif surfaced in a storyline, optionally pinned to one beat.
 *
 * Three ownership facts are established before writing, because the row joins
 * three tables that know nothing about each other: the motif is the caller's,
 * the storyline is the caller's, and — when given — the event belongs to *that*
 * storyline. invariants.md §3 names the last one: "a callback pointing at the
 * wrong story's beat."
 *
 * `eventId` stays optional, since a motif can colour a whole storyline without
 * attaching to one exact moment.
 */
export async function recordMotifOccurrence(
  userId: string,
  motifId: string,
  storylineId: string,
  eventId?: string
): Promise<{ id: string }> {
  const motif = await reader.getMotif(userId, motifId);
  if (!motif) throw new NotFoundError('Motif', motifId);

  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  if (eventId && !(await reader.eventBelongsToStoryline(storylineId, eventId))) {
    throw new ValidationError('That event belongs to a different storyline');
  }

  const inserted = await writer.insertMotifOccurrenceIfAbsent({ motifId, storylineId, eventId });
  if (inserted) return inserted;

  throw new ConflictError('This motif is already recorded for that storyline');
}
