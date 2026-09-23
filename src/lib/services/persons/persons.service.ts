import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as reader from './persons.reader';
import * as writer from './persons.writer';
import { hashContactHandle } from './persons.contact';
import { PublicPerson, VoiceProfile } from './persons.types';

/**
 * The account holder's own `persons` row, created on first request.
 *
 * invariants.md §5: "Every user needs exactly one `isSelf` person. The partial
 * unique index stops a second one, but nothing creates the first." Nothing did,
 * so this is that function. It matters because the user is cast as a `character`
 * like anyone else — without this row a storyline cannot include its own
 * protagonist.
 *
 * Read, insert-if-absent, read again, mirroring users.service.ts: the partial
 * unique index arbitrates the race rather than the application, so two
 * concurrent first requests produce one row and both callers see it.
 */
export async function getOrCreateSelfPerson(userId: string, name: string): Promise<PublicPerson> {
  const existing = await reader.getSelfPerson(userId);
  if (existing) return existing;

  const inserted = await writer.insertPersonIfAbsent({ userId, name, isSelf: true });
  if (inserted) return inserted;

  // The insert was a no-op, which for isSelf can only mean a concurrent caller
  // won the race — there is no other constraint it could have hit, since this
  // insert carries no sourceContactRef.
  const raced = await reader.getSelfPerson(userId);
  if (raced) return raced;

  throw new ConflictError('Could not provision the account holder as a person');
}

/**
 * Finds the person behind a contact handle, creating one on first sight.
 *
 * The raw handle is hashed here and never leaves this function — the writer's
 * input type only accepts a `ContactRef`, so the raw value cannot reach the
 * column even by mistake. invariants.md §1.
 *
 * Both the lookup and the insert hash through the same helper. If they ever
 * disagreed, the same contact would get a second `persons` row and
 * cross-storyline continuity would silently stop working for that person.
 */
export async function getOrCreatePersonByHandle(
  userId: string,
  handle: string,
  name: string
): Promise<PublicPerson> {
  const ref = hashContactHandle(handle);

  const existing = await reader.getPersonByContactRef(userId, ref);
  if (existing) return existing;

  const inserted = await writer.insertPersonIfAbsent({ userId, name, sourceContactRef: ref });
  if (inserted) return inserted;

  const raced = await reader.getPersonByContactRef(userId, ref);
  if (raced) return raced;

  throw new ConflictError(`Could not provision a person for ${name}`);
}

/** A person with no contact handle — someone mentioned in a story but never messaged. */
export async function createPerson(
  userId: string,
  input: { name: string; voiceProfile?: VoiceProfile }
): Promise<PublicPerson> {
  const person = await writer.insertPersonIfAbsent({ userId, ...input });
  if (!person) throw new ConflictError(`Could not create a person named ${input.name}`);
  return person;
}

export async function getPerson(userId: string, personId: string): Promise<PublicPerson> {
  const person = await reader.getPerson(userId, personId);
  if (!person) throw new NotFoundError('Person', personId);
  return person;
}

export const listPersons = reader.listPersons;

/**
 * Records that two people are something to each other — siblings, coworkers.
 *
 * Takes the two ids in any order and sorts them, because
 * `personRelationships` carries `CHECK (person_a_id < person_b_id)` so that a
 * pair cannot be stored twice reversed (invariants.md §2).
 *
 * `userId` is the *caller's*, and both ids are verified to belong to it before
 * anything is written. No foreign key enforces that — invariants.md §3 lists
 * "a relationship joining two users' contacts" as one of the silent failures —
 * and taking `userId` alongside two unchecked ids is exactly the shape that
 * produces one.
 */
export async function linkPersons(
  userId: string,
  personOneId: string,
  personTwoId: string,
  relationshipType?: string
): Promise<{ id: string }> {
  if (personOneId === personTwoId) {
    throw new ValidationError('A person cannot be related to themselves');
  }

  const owned = await reader.ownedPersonIds(userId, [personOneId, personTwoId]);
  if (owned.size !== 2) {
    // Deliberately not naming which id failed: to a caller who does not own it,
    // "that person is not yours" and "no such person" should be the same answer.
    throw new NotFoundError('Person');
  }

  const [personAId, personBId] = [personOneId, personTwoId].sort();

  const inserted = await writer.insertPersonRelationshipIfAbsent({
    userId,
    personAId,
    personBId,
    relationshipType,
  });
  if (inserted) return inserted;

  // Untargeted onConflictDoNothing, so a no-op means the pair already exists.
  throw new ConflictError('These two people are already related');
}
