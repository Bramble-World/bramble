import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { db } from '@/index';
import { characters, events, storylines } from '@/db/schema/tables';
import { CharacterRole, PublicCharacter, PublicStoryline } from './storylines.types';

const storylineColumns = {
  id: storylines.id,
  title: storylines.title,
  sourceSurface: storylines.sourceSurface,
  setting: storylines.setting,
  tone: storylines.tone,
  status: storylines.status,
  failureReason: storylines.failureReason,
  arcSummary: storylines.arcSummary,
  arcSummaryGeneratedAt: storylines.arcSummaryGeneratedAt,
  createdAt: storylines.createdAt,
};

const characterColumns = {
  id: characters.id,
  storylineId: characters.storylineId,
  personId: characters.personId,
  role: characters.role,
  description: characters.description,
  want: characters.want,
  avoids: characters.avoids,
  voiceProfileOverride: characters.voiceProfileOverride,
};

export async function listStorylines(userId: string): Promise<PublicStoryline[]> {
  return db
    .select(storylineColumns)
    .from(storylines)
    .where(eq(storylines.userId, userId))
    .orderBy(desc(storylines.createdAt));
}

/**
 * Scoped by userId, like every read here. `storylines.userId` is the only thing
 * that ties a story to its owner, and no foreign key consults it when a child
 * row is written — so if ownership is not checked on the way in, it is not
 * checked at all.
 */
export async function getStoryline(
  userId: string,
  storylineId: string
): Promise<PublicStoryline | null> {
  const [storyline] = await db
    .select(storylineColumns)
    .from(storylines)
    .where(and(eq(storylines.userId, userId), eq(storylines.id, storylineId)))
    .limit(1);
  return storyline ?? null;
}

/** Whether these storyline ids all belong to the user. Used before writing a link. */
export async function ownedStorylineIds(
  userId: string,
  storylineIds: string[]
): Promise<Set<string>> {
  if (storylineIds.length === 0) return new Set();
  const rows = await db
    .select({ id: storylines.id })
    .from(storylines)
    .where(and(eq(storylines.userId, userId), inArray(storylines.id, storylineIds)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The newest event's createdAt — the watermark an arc summary is stamped with.
 *
 * Read *before* the model call and written after it, unchanged. Stamping with
 * `now()` instead would silently swallow anything written during the call: an
 * event created while the model was thinking would end up older than the summary
 * that does not include it, so the staleness check would conclude there is
 * nothing to recompute and keep concluding that forever. Nothing errors; the
 * summary is simply wrong from then on.
 */
export async function newestEventCreatedAt(storylineId: string): Promise<Date | null> {
  const [row] = await db
    .select({ newest: max(events.createdAt) })
    .from(events)
    .where(eq(events.storylineId, storylineId));
  return row?.newest ?? null;
}

export async function listCharacters(storylineId: string): Promise<PublicCharacter[]> {
  return db
    .select(characterColumns)
    .from(characters)
    .where(eq(characters.storylineId, storylineId))
    .orderBy(asc(characters.createdAt));
}

/**
 * Which of these character ids belong to the given storyline.
 *
 * `characterRelationships` carries `storylineId` alongside two character ids and
 * no foreign key relates them, so "a relationship spanning two storylines"
 * (invariants.md §3) is writable and looks entirely valid afterwards. This is
 * how the service refuses it.
 */
export async function charactersInStoryline(
  storylineId: string,
  characterIds: string[]
): Promise<Set<string>> {
  if (characterIds.length === 0) return new Set();
  const rows = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.storylineId, storylineId), inArray(characters.id, characterIds)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The storylines a person is cast in — "arcs with James", screens 10 and 11.
 *
 * Scoped on `storylines.userId` rather than on the person, because `characters`
 * carries no owner column of its own: reaching it through a person id alone
 * would be an unscoped read wearing a scoped id.
 *
 * `role` travels with each arc. Until several conversations are imported every
 * person yields the same one storyline with the same title, and a list of
 * identical rows reads as a bug rather than as sparse data; the role is the one
 * honest thing that differs between them.
 */
export async function arcsForPerson(
  userId: string,
  personId: string
): Promise<Array<{ storyline: PublicStoryline; role: CharacterRole }>> {
  const rows = await db
    .select({ ...storylineColumns, role: characters.role })
    .from(characters)
    .innerJoin(storylines, eq(storylines.id, characters.storylineId))
    .where(and(eq(storylines.userId, userId), eq(characters.personId, personId)))
    .orderBy(desc(storylines.createdAt));

  return rows.map(({ role, ...storyline }) => ({ storyline, role }));
}
