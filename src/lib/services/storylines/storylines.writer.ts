import { and, eq } from 'drizzle-orm';
import { db } from '@/index';
import { characterRelationships, characters, storylineLinks, storylines } from '@/db/schema/tables';
import {
  CharacterRole,
  Dynamic,
  NewStoryline,
  PublicCharacter,
  PublicStoryline,
  StorylineLinkType,
} from './storylines.types';

const returnedStoryline = {
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

export async function insertStoryline(
  userId: string,
  input: NewStoryline
): Promise<PublicStoryline> {
  const [storyline] = await db
    .insert(storylines)
    .values({ userId, ...input })
    .returning(returnedStoryline);
  return storyline;
}

/**
 * The only way to move a storyline's status, and the only way to touch
 * `failureReason`.
 *
 * The two are written together because they are one fact. invariants.md §4
 * requires `failureReason` to be set exactly when `status = 'failed'` and null
 * otherwise, and nothing in the database ties them — a failed storyline with no
 * reason, or a ready one still carrying a stale reason from an earlier attempt,
 * both read as perfectly valid rows. Making this the single write path is what
 * keeps them consistent, so callers get `markFailed` / `markStatus` rather than
 * a general-purpose patch.
 */
export async function setStorylineStatus(
  userId: string,
  storylineId: string,
  status: 'pending' | 'generating' | 'ready'
): Promise<PublicStoryline | null>;
export async function setStorylineStatus(
  userId: string,
  storylineId: string,
  status: 'failed',
  failureReason: string
): Promise<PublicStoryline | null>;
export async function setStorylineStatus(
  userId: string,
  storylineId: string,
  status: PublicStoryline['status'],
  failureReason?: string
): Promise<PublicStoryline | null> {
  const [storyline] = await db
    .update(storylines)
    .set({
      status,
      // Cleared on every non-failed transition, so a retry that succeeds does
      // not leave the previous attempt's reason behind.
      failureReason: status === 'failed' ? (failureReason ?? null) : null,
    })
    .where(and(eq(storylines.userId, userId), eq(storylines.id, storylineId)))
    .returning(returnedStoryline);
  return storyline ?? null;
}

export async function insertCharacterIfAbsent(input: {
  storylineId: string;
  personId: string;
  role?: CharacterRole;
  description?: string;
}): Promise<PublicCharacter | null> {
  const [character] = await db.insert(characters).values(input).onConflictDoNothing().returning({
    id: characters.id,
    storylineId: characters.storylineId,
    personId: characters.personId,
    role: characters.role,
    description: characters.description,
    voiceProfileOverride: characters.voiceProfileOverride,
  });
  return character ?? null;
}

/**
 * Takes the character ids already sorted and already proven to belong to
 * `storylineId`. The CHECK catches an unsorted call loudly; nothing catches a
 * cross-storyline one, which is why that proof happens in the service.
 */
export async function insertCharacterRelationshipIfAbsent(input: {
  storylineId: string;
  characterAId: string;
  characterBId: string;
  baselineDynamic?: Dynamic;
}): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(characterRelationships)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: characterRelationships.id });
  return row ?? null;
}

export async function insertStorylineLinkIfAbsent(input: {
  storylineAId: string;
  storylineBId: string;
  linkType: StorylineLinkType;
}): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(storylineLinks)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: storylineLinks.id });
  return row ?? null;
}
