import { and, eq, sql } from 'drizzle-orm';
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
  createdAt: storylines.createdAt,
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

/**
 * Sets the narrative framing a storyline is given once it has been extracted.
 *
 * Separate from the status path, which owns `failureReason` and nothing else.
 * A storyline is created before the model runs — so there is something to show
 * and something to mark failed — which means its title starts as a placeholder
 * and has to be replaced once the model has actually read the conversation.
 */
export async function setStorylineNarrative(
  userId: string,
  storylineId: string,
  input: { title: string; tone?: string; setting?: string }
): Promise<PublicStoryline | null> {
  const [storyline] = await db
    .update(storylines)
    .set({ title: input.title, tone: input.tone, setting: input.setting })
    .where(and(eq(storylines.userId, userId), eq(storylines.id, storylineId)))
    .returning(returnedStoryline);
  return storyline ?? null;
}

/**
 * Writes an arc summary, but only if nobody else has written one since.
 *
 * `expected` is the `arcSummaryGeneratedAt` observed before the model was
 * called, and the update is conditional on it still being that. A sweep that
 * took eight seconds must not overwrite a fresher summary produced while it was
 * thinking — and since the recompute is triggered by idleness rather than by a
 * lock, two sweeps overlapping is ordinary rather than exceptional.
 *
 * `IS NOT DISTINCT FROM` rather than `=`, because the expected value is null the
 * first time and `null = null` is not true.
 *
 * Returns whether it won.
 */
export async function setArcSummaryIfUnchanged(input: {
  storylineId: string;
  summary: string;
  watermark: Date;
  expected: Date | null;
}): Promise<boolean> {
  const rows = await db
    .update(storylines)
    .set({ arcSummary: input.summary, arcSummaryGeneratedAt: input.watermark })
    .where(
      and(
        eq(storylines.id, input.storylineId),
        sql`${storylines.arcSummaryGeneratedAt} IS NOT DISTINCT FROM ${input.expected}`
      )
    )
    .returning({ id: storylines.id });

  return rows.length > 0;
}

/**
 * Deletes a storyline and everything hanging off it.
 *
 * Scoped to the owner, and relies on the cascades already in the schema —
 * characters, relationships, events, context entries, sessions, turns and
 * choices all go with it. Motifs do not: they belong to the user rather than to
 * any one story, which is the whole reason they are user-scoped.
 */
export async function deleteStoryline(userId: string, storylineId: string): Promise<boolean> {
  const rows = await db
    .delete(storylines)
    .where(and(eq(storylines.userId, userId), eq(storylines.id, storylineId)))
    .returning({ id: storylines.id });
  return rows.length > 0;
}

/**
 * Deletes every storyline except the batch the seed wrote.
 *
 * The seed runs in one transaction, so all of its storylines share an identical
 * `created_at`, and the earliest such instant identifies that batch. Everything
 * later was extracted afterwards — by an import, a fixture button, or a test.
 *
 * That is a harness-grade heuristic rather than real provenance, which would
 * need a column. It is honest about what it does, and it is only reachable from
 * the lab.
 */
export async function deleteStorylinesAfterSeed(userId: string): Promise<number> {
  const rows = await db
    .delete(storylines)
    .where(
      and(
        eq(storylines.userId, userId),
        sql`${storylines.createdAt} > (SELECT min(created_at) FROM ${storylines})`
      )
    )
    .returning({ id: storylines.id });
  return rows.length;
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
