import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/index';
import { personRelationships, persons } from '@/db/schema/tables';
import { ContactRef } from './persons.contact';
import { NewPerson, PublicPerson, VoiceProfile } from './persons.types';

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
 * Fills in a person's voice, but only where there is nothing there yet.
 *
 * `WHERE voice_profile IS NULL` is the whole design. Extraction produces a fresh
 * reading of how someone speaks every time it sees them, and letting the newest
 * one win would mean a person's voice was decided by whichever conversation was
 * imported last — including a thin one where they barely spoke. Filling only a
 * gap makes this repair, not churn, and makes the call safe to make on every
 * extraction rather than only a first one.
 *
 * A per-storyline reading belongs on `characters.voiceProfileOverride`, which
 * the context reader already prefers over this column. Nothing writes it yet.
 */
export async function setVoiceProfileIfAbsent(
  personId: string,
  userId: string,
  voiceProfile: VoiceProfile
): Promise<PublicPerson | null> {
  const [person] = await db
    .update(persons)
    .set({ voiceProfile })
    .where(and(eq(persons.id, personId), eq(persons.userId, userId), isNull(persons.voiceProfile)))
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

/**
 * Gives a person their contact handle, if they do not already have one.
 *
 * For someone who was previously only mentioned: they have a row, nobody had
 * heard from them, and now a transcript shows them speaking. Claiming the
 * existing row is better than creating a second person for a human the model
 * correctly recognised.
 *
 * Guarded on the ref being null rather than overwriting, and that guard is the
 * point: a person already identified by one handle must not be re-pointed at
 * another, because that is how two humans become one row. Returns null when
 * there was nothing to claim, so the caller can fall back rather than assume.
 */
export async function setContactRefIfAbsent(
  userId: string,
  personId: string,
  sourceContactRef: ContactRef
): Promise<PublicPerson | null> {
  const [person] = await db
    .update(persons)
    .set({ sourceContactRef })
    .where(
      and(eq(persons.id, personId), eq(persons.userId, userId), isNull(persons.sourceContactRef))
    )
    .returning(returned);

  return person ?? null;
}
