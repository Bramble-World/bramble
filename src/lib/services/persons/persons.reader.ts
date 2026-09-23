import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/index';
import { persons } from '@/db/schema/tables';
import { ContactRef } from './persons.contact';
import { PublicPerson } from './persons.types';

/** The projection every reader here returns. Excludes sourceContactRef by design. */
const columns = {
  id: persons.id,
  name: persons.name,
  isSelf: persons.isSelf,
  voiceProfile: persons.voiceProfile,
};

export async function listPersons(userId: string): Promise<PublicPerson[]> {
  return db
    .select(columns)
    .from(persons)
    .where(eq(persons.userId, userId))
    .orderBy(asc(persons.name));
}

/**
 * Scoped by userId, not just id. Every read in this file is, so that a person id
 * leaked or guessed from elsewhere cannot be used to read another user's
 * contacts — nothing in the schema scopes a row to its owner on its own.
 */
export async function getPerson(userId: string, personId: string): Promise<PublicPerson | null> {
  const [person] = await db
    .select(columns)
    .from(persons)
    .where(and(eq(persons.userId, userId), eq(persons.id, personId)))
    .limit(1);
  return person ?? null;
}

export async function getSelfPerson(userId: string): Promise<PublicPerson | null> {
  const [person] = await db
    .select(columns)
    .from(persons)
    .where(and(eq(persons.userId, userId), eq(persons.isSelf, true)))
    .limit(1);
  return person ?? null;
}

/** Contact de-duplication: "have I already created a person for this handle?" */
export async function getPersonByContactRef(
  userId: string,
  ref: ContactRef
): Promise<PublicPerson | null> {
  const [person] = await db
    .select(columns)
    .from(persons)
    .where(and(eq(persons.userId, userId), eq(persons.sourceContactRef, ref)))
    .limit(1);
  return person ?? null;
}

/**
 * Which of these person ids the user actually owns.
 *
 * The caller compares the count, not the contents — it exists so a write can
 * refuse ids belonging to someone else before touching a pair table. All seven
 * cross-scope rules in invariants.md §3 are unenforced by any foreign key, so
 * this check is the only thing standing between a caller and a row that joins
 * two users' data while looking perfectly valid.
 */
export async function ownedPersonIds(userId: string, personIds: string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await db
    .select({ id: persons.id })
    .from(persons)
    .where(and(eq(persons.userId, userId), inArray(persons.id, personIds)));
  return new Set(rows.map((r) => r.id));
}
