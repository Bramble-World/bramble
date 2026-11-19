import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { env } from '@/env';
import { db } from '@/index';
import { characters, persons, storylines, storyTemplates, users } from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { withIosClient } from '@/lib/analytics/client-context';
import { contextText, type ChatGPTContext } from '@/lib/chatgpt/context';
import { getSafetyCheck, type SafetyCheck } from '@/lib/onboarding/safety';
import { enqueueForContext } from '../pool/pool.writer';
import { apnsConfigured } from '../push/apns';
import { MESSAGES } from '../push/push.policy';
import { sendToUser } from '../push/push.service';

/**
 * Bramble in ChatGPT: the stories a player asks ChatGPT for, written from what
 * it sends (`/api/mcp`), and played on the iPhone as their next story.
 *
 * Only ever that player's: a `chatgpt` template is never offered to anyone else
 * (`choose()` in next.service.ts; invariants.md §3), and what ChatGPT sent is
 * deleted once the story is written (`runTemplate`). Nothing here logs or
 * tracks any of it: outcomes are codes.
 */

/** Stories a player may ask for in a day: each is two model calls, and a story to play. */
export const CHATGPT_STORIES_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StoryRequest =
  | { outcome: 'queued'; storyId: string; left: number }
  | { outcome: 'limited'; left: 0 }
  | { outcome: 'flagged' };

/** Records that this account uses Bramble in ChatGPT, the first time it does. */
export async function markConnected(userId: string): Promise<void> {
  const [first] = await db
    .update(users)
    .set({ chatgptConnectedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.chatgptConnectedAt)))
    .returning({ id: users.id });
  if (first) await track(userId, { name: 'chatgpt_connected', properties: {} });
}

async function requestedToday(userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storyTemplates)
    .where(
      and(
        eq(storyTemplates.userId, userId),
        eq(storyTemplates.origin, 'chatgpt'),
        // One Bramble couldn't write doesn't use up the day.
        inArray(storyTemplates.status, ['pending', 'generating', 'ready']),
        gt(storyTemplates.createdAt, new Date(now.getTime() - DAY_MS))
      )
    );
  return row?.count ?? 0;
}

/**
 * Queues a story from what ChatGPT sent. Moderated first, as a reborn answer
 * is: a flagged context is not kept at all. If moderation can't be reached, the
 * story is queued anyway, since everything written from it is moderated again
 * before it can be played.
 */
export async function requestStory(
  userId: string,
  context: ChatGPTContext,
  { safety = getSafetyCheck(), now = new Date() }: { safety?: SafetyCheck; now?: Date } = {}
): Promise<StoryRequest> {
  const used = await requestedToday(userId, now);
  if (used >= CHATGPT_STORIES_PER_DAY) {
    await track(userId, { name: 'chatgpt_story_requested', properties: { outcome: 'limited' } });
    return { outcome: 'limited', left: 0 };
  }

  let flagged = false;
  try {
    ({ flagged } = await safety(contextText(context)));
  } catch {
    flagged = false;
  }
  if (flagged) {
    await track(userId, { name: 'chatgpt_story_requested', properties: { outcome: 'flagged' } });
    return { outcome: 'flagged' };
  }

  const storyId = await db.transaction((tx) => enqueueForContext(tx, userId, context));
  await track(userId, { name: 'chatgpt_story_requested', properties: { outcome: 'queued' } });
  return { outcome: 'queued', storyId, left: CHATGPT_STORIES_PER_DAY - used - 1 };
}

/**
 * "your story's ready.": once, when a story asked for in ChatGPT has been
 * written, to a player with notifications on. The text names no one. Called by
 * the pool job; it never throws, because the story is written either way.
 */
export async function announceStoryReady(templateId: string): Promise<void> {
  if (env.PUSH_ENABLED !== 'true' || !apnsConfigured()) return;
  try {
    const [row] = await db
      .select({ userId: users.id })
      .from(storyTemplates)
      .innerJoin(users, eq(users.id, storyTemplates.userId))
      .where(
        and(
          eq(storyTemplates.id, templateId),
          eq(storyTemplates.origin, 'chatgpt'),
          eq(users.pushEnabled, true)
        )
      )
      .limit(1);
    if (!row) return;
    const sent = await sendToUser(row.userId, MESSAGES.story_ready, 'story_ready');
    if (sent.delivered > 0) {
      await withIosClient(() =>
        track(row.userId, { name: 'push_sent', properties: { kind: 'story_ready' } })
      );
    }
  } catch {
    // A notification that didn't go is not worth failing a written story over.
  }
}

/** How a story asked for in ChatGPT is doing, as ChatGPT and the iPhone say it. */
export type ChatGPTStoryStatus = 'writing' | 'ready' | 'playing' | 'not_written';

/**
 * Why a story wasn't written, as ChatGPT is told it: a code, so it can ask the
 * player for what was missing. Every safety code is `unsafe`, so the reply says
 * nothing about what the story touched on.
 */
export const CHATGPT_STORY_REASONS = [
  'too_thin',
  'not_a_story',
  'unclear',
  'weak',
  'unsafe',
  'failed',
] as const;
export type ChatGPTStoryReason = (typeof CHATGPT_STORY_REASONS)[number];

type TemplateReason = NonNullable<(typeof storyTemplates.$inferSelect)['reason']>;

export function storyReason(reason: TemplateReason | null): ChatGPTStoryReason {
  switch (reason) {
    case 'too_thin':
    case 'not_a_story':
    case 'unclear':
      return reason;
    case 'low_quality':
      return 'weak';
    case 'generation_failed':
    case null:
      return 'failed';
    default:
      return 'unsafe';
  }
}

export type ChatGPTStory = {
  storyId: string;
  status: ChatGPTStoryStatus;
  /** Only once it's written. */
  title: string | null;
  requestedAt: Date;
  /** Only when it's `not_written`. */
  reason: ChatGPTStoryReason | null;
};

/** This player's stories from ChatGPT, newest first. */
export async function listStories(userId: string): Promise<ChatGPTStory[]> {
  const rows = await db
    .select({
      id: storyTemplates.id,
      status: storyTemplates.status,
      reason: storyTemplates.reason,
      content: storyTemplates.content,
      createdAt: storyTemplates.createdAt,
      started: sql<boolean>`exists (
        select 1 from "storylines" "s"
        where "s"."user_id" = ${userId} and "s"."template_id" = "story_templates"."id"
      )`,
    })
    .from(storyTemplates)
    .where(and(eq(storyTemplates.userId, userId), eq(storyTemplates.origin, 'chatgpt')))
    .orderBy(sql`${storyTemplates.createdAt} desc`);

  return rows.map((row) => {
    const status: ChatGPTStoryStatus =
      row.status === 'pending' || row.status === 'generating'
        ? 'writing'
        : row.status === 'ready'
          ? row.started
            ? 'playing'
            : 'ready'
          : 'not_written';
    return {
      storyId: row.id,
      status,
      title: row.status === 'ready' ? (row.content?.title ?? null) : null,
      requestedAt: row.createdAt,
      reason: status === 'not_written' ? storyReason(row.reason) : null,
    };
  });
}

/** What the iPhone shows: connected at all, and a story being written now. */
export async function chatgptStatus(
  userId: string
): Promise<{ connected: boolean; writing: boolean }> {
  const [user] = await db
    .select({ connectedAt: users.chatgptConnectedAt })
    .from(users)
    .where(eq(users.id, userId));
  const [writing] = await db
    .select({ id: storyTemplates.id })
    .from(storyTemplates)
    .where(
      and(
        eq(storyTemplates.userId, userId),
        eq(storyTemplates.origin, 'chatgpt'),
        inArray(storyTemplates.status, ['pending', 'generating'])
      )
    )
    .limit(1);
  return { connected: Boolean(user?.connectedAt), writing: Boolean(writing) };
}

/**
 * Deletes a story asked for in ChatGPT, and every copy of it in this player's
 * world: the storyline and its playthroughs, and the people it brought in (who
 * have real names). False when there's no such story of theirs.
 */
export async function deleteStory(userId: string, storyId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [template] = await tx
      .select({ id: storyTemplates.id })
      .from(storyTemplates)
      .where(
        and(
          eq(storyTemplates.id, storyId),
          eq(storyTemplates.userId, userId),
          eq(storyTemplates.origin, 'chatgpt')
        )
      )
      .for('update');
    if (!template) return false;

    const copies = await tx
      .select({ id: storylines.id })
      .from(storylines)
      .where(and(eq(storylines.userId, userId), eq(storylines.templateId, storyId)));
    const copyIds = copies.map((c) => c.id);

    if (copyIds.length) {
      const cast = await tx
        .select({ personId: characters.personId })
        .from(characters)
        .innerJoin(persons, eq(persons.id, characters.personId))
        .where(and(inArray(characters.storylineId, copyIds), eq(persons.isSelf, false)));
      // Cascades to sessions, turns, characters, events and context.
      await tx.delete(storylines).where(inArray(storylines.id, copyIds));
      const castIds = [...new Set(cast.map((c) => c.personId))];
      if (castIds.length) {
        // Only people no other story still has.
        await tx
          .delete(persons)
          .where(
            and(
              eq(persons.userId, userId),
              inArray(persons.id, castIds),
              ne(persons.isSelf, true),
              sql`not exists (select 1 from "characters" "c" where "c"."person_id" = "persons"."id")`
            )
          );
      }
    }

    // The context, if it's still being written, goes with it (`set null` is
    // only for a finished one, which is already gone).
    const [row] = await tx
      .delete(storyTemplates)
      .where(eq(storyTemplates.id, storyId))
      .returning({ contextId: storyTemplates.sourceContextId });
    if (row?.contextId) {
      await tx.execute(sql`delete from "chatgpt_contexts" where "id" = ${row.contextId}`);
    }
    return true;
  });
}
