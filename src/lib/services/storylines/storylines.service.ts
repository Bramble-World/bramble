import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as personReader from '../persons/persons.reader';
import * as reader from './storylines.reader';
import * as writer from './storylines.writer';
import {
  CharacterRole,
  Dynamic,
  NewStoryline,
  PublicCharacter,
  PublicStoryline,
  StorylineLinkType,
} from './storylines.types';

/**
 * Link types where the two storylines are interchangeable.
 *
 * `storylineLinks` has no ordering CHECK, deliberately, because `sequel` and
 * `spinoff` are directional — A precedes B and swapping them says something
 * different. `parallel` and `crossover` are not, so without a convention the
 * same pair could be stored twice reversed and both rows would be correct.
 * invariants.md §6 left this open ("Decide a convention if those get used");
 * sorting the ids for exactly these two is that decision, and it matches how the
 * seed already writes them.
 */
const UNORDERED_LINKS = new Set<StorylineLinkType>(['parallel', 'crossover']);

export async function createStoryline(
  userId: string,
  input: NewStoryline
): Promise<PublicStoryline> {
  return writer.insertStoryline(userId, input);
}

export async function getStoryline(userId: string, storylineId: string): Promise<PublicStoryline> {
  const storyline = await reader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);
  return storyline;
}

export const listStorylines = reader.listStorylines;
export const listCharacters = reader.listCharacters;

/** Moves a storyline to a non-failed state, clearing any earlier failure reason. */
export async function markStatus(
  userId: string,
  storylineId: string,
  status: 'pending' | 'generating' | 'ready'
): Promise<PublicStoryline> {
  const storyline = await writer.setStorylineStatus(userId, storylineId, status);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);
  return storyline;
}

/**
 * The only route to `status: 'failed'`, and it cannot be reached without a
 * reason — the parameter is required. invariants.md §4 lists "a `failed`
 * storyline with no reason" as reading perfectly valid.
 */
export async function markFailed(
  userId: string,
  storylineId: string,
  reason: string
): Promise<PublicStoryline> {
  if (!reason.trim()) {
    throw new ValidationError('A failed storyline needs a reason', {
      reason: 'must not be empty',
    });
  }
  const storyline = await writer.setStorylineStatus(userId, storylineId, 'failed', reason);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);
  return storyline;
}

/**
 * Casts a person in a storyline.
 *
 * Verifies that the storyline and the person belong to the *same* user before
 * writing. `characters` points at both with two independent single-column
 * foreign keys, so "a storyline cast with another user's person" (invariants.md
 * §3) is writable today and produces a row that looks entirely normal — the
 * person's name would simply appear in a stranger's story.
 */
export async function castCharacter(
  userId: string,
  storylineId: string,
  personId: string,
  input: { role?: CharacterRole; description?: string } = {}
): Promise<PublicCharacter> {
  // Both reads are scoped to userId, so this proves common ownership without
  // ever comparing two userIds by hand.
  const storyline = await reader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  const person = await personReader.getPerson(userId, personId);
  if (!person) throw new NotFoundError('Person', personId);

  const character = await writer.insertCharacterIfAbsent({ storylineId, personId, ...input });
  if (character) return character;

  // `idx_characters_storyline_person` is unique, so a no-op means this person is
  // already cast. Return the existing casting rather than failing: re-casting is
  // a natural retry, not a conflict.
  const existing = (await reader.listCharacters(storylineId)).find((c) => c.personId === personId);
  if (existing) return existing;

  throw new ConflictError('Could not cast this person in the storyline');
}

/**
 * Records how two characters stand at the start of a storyline.
 *
 * Two rules meet here, both from invariants.md. The pair is sorted because
 * `CHECK (character_a_id < character_b_id)` rejects the reverse (§2, loud). Both
 * characters are proven to belong to `storylineId` because nothing else will
 * (§3, silent) — `characterRelationships` carries a `storylineId` of its own,
 * and a row naming two characters from a different story is accepted without
 * complaint.
 */
export async function relateCharacters(
  userId: string,
  storylineId: string,
  characterOneId: string,
  characterTwoId: string,
  baselineDynamic?: Dynamic
): Promise<{ id: string }> {
  if (characterOneId === characterTwoId) {
    throw new ValidationError('A character cannot be related to themselves');
  }

  const storyline = await reader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  const inStoryline = await reader.charactersInStoryline(storylineId, [
    characterOneId,
    characterTwoId,
  ]);
  if (inStoryline.size !== 2) {
    throw new ValidationError('Both characters must belong to this storyline');
  }

  const [characterAId, characterBId] = [characterOneId, characterTwoId].sort();

  const inserted = await writer.insertCharacterRelationshipIfAbsent({
    storylineId,
    characterAId,
    characterBId,
    baselineDynamic,
  });
  if (inserted) return inserted;

  throw new ConflictError('These two characters are already related in this storyline');
}

/**
 * Connects two storylines.
 *
 * Both are verified to belong to the caller, and the ids are sorted only for the
 * link types where direction carries no meaning — see UNORDERED_LINKS above.
 */
export async function linkStorylines(
  userId: string,
  fromStorylineId: string,
  toStorylineId: string,
  linkType: StorylineLinkType
): Promise<{ id: string }> {
  if (fromStorylineId === toStorylineId) {
    throw new ValidationError('A storyline cannot be linked to itself');
  }

  const owned = await reader.ownedStorylineIds(userId, [fromStorylineId, toStorylineId]);
  if (owned.size !== 2) throw new NotFoundError('Storyline');

  const [storylineAId, storylineBId] = UNORDERED_LINKS.has(linkType)
    ? [fromStorylineId, toStorylineId].sort()
    : [fromStorylineId, toStorylineId];

  const inserted = await writer.insertStorylineLinkIfAbsent({
    storylineAId,
    storylineBId,
    linkType,
  });
  if (inserted) return inserted;

  throw new ConflictError(`These storylines are already linked as ${linkType}`);
}
