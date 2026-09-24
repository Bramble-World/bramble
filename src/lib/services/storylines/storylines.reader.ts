import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { db } from '@/index';
import { characters, events, storylines } from '@/db/schema/tables';
import { PublicCharacter, PublicStoryline } from './storylines.types';

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
