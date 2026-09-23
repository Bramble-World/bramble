import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/index';
import { characters, storylines } from '@/db/schema/tables';
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
