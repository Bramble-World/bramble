import { db } from '@/index';
import { personRelationships, persons } from '@/db/schema/tables';
import { NewPerson, PublicPerson } from './persons.types';

const returned = {
  id: persons.id,
  name: persons.name,
  isSelf: persons.isSelf,
  voiceProfile: persons.voiceProfile,
};

/**
 * Inserts a person, or does nothing if one already exists for this contact.
 *
 * `onConflictDoNothing()` is untargeted, matching users.writer.ts: both unique
 * indexes on this table can conflict — `(userId, sourceContactRef)` and the
 * partial one-self-per-user — and the caller reads back to learn which.
 */
export async function insertPersonIfAbsent(input: NewPerson): Promise<PublicPerson | null> {
  const [person] = await db
    .insert(persons)
    .values({
      userId: input.userId,
      name: input.name,
      sourceContactRef: input.sourceContactRef,
      isSelf: input.isSelf ?? false,
      voiceProfile: input.voiceProfile,
    })
    .onConflictDoNothing()
    .returning(returned);

  return person ?? null;
}

/**
 * Inserts a relationship between two people, or does nothing if the pair is
 * already recorded.
 *
 * Takes the ids already sorted. The table carries
 * `CHECK (person_a_id < person_b_id)` so an unsorted call fails loudly, but the
 * sort belongs to the service, which is also where both ids are proven to belong
 * to `userId` — this writer trusts that and only writes.
 */
export async function insertPersonRelationshipIfAbsent(input: {
  userId: string;
  personAId: string;
  personBId: string;
  relationshipType?: string;
}): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(personRelationships)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: personRelationships.id });

  return row ?? null;
}
