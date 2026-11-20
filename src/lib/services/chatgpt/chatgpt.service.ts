import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { env } from '@/env';
import { db } from '@/index';
import { characters, persons, storylines, storyTemplates, users } from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { withIosClient } from '@/lib/analytics/client-context';
import { getGenerator, type Generator } from '@/lib/ai';
import { TURN_DEADLINE_MS, withDeadline } from '@/lib/ai/deadline';
import { MAX_LINK_SITUATIONS, situationsPrompt } from '@/lib/ai/prompts/situations.prompt';
import { chatgptContextSchema, contextText, type ChatGPTContext } from '@/lib/chatgpt/context';
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

/**
 * Stories a player may ask for in a day, however they ask (`write_my_story`,
 * or a link): each is two model calls, and a story to play. Five, so one link
 * with five situations in it can make all five.
 */
export const CHATGPT_STORIES_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How the request reached us: ChatGPT calling `write_my_story` (`mcp`), or the
 * iPhone sending the situations in a link ChatGPT wrote (`link`).
 */
export type StoryRequestVia = 'mcp' | 'link';

/** `retryAt`: when the oldest of the day's stories stops counting, and one more may be asked for. */
type Limited = { outcome: 'limited'; left: 0; retryAt: Date };

export type StoryRequest =
  | { outcome: 'queued'; storyId: string; left: number }
  | Limited
  | { outcome: 'flagged' };

export type StoriesRequest =
  /**
   * `overLimit`: situations left unwritten because the day ran out; `flagged`:
   * situations moderation flagged, which are not kept.
   */
  | { outcome: 'queued'; storyIds: string[]; left: number; overLimit: number; flagged: number }
  | Limited
  /** Every situation was flagged, and none is kept. */
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

async function requestedToday(
  userId: string,
  now: Date
): Promise<{ count: number; oldest: Date | null }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${storyTemplates.createdAt})`.mapWith(storyTemplates.createdAt),
    })
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
  return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
}

/** What is left of today's allowance, and when the next one comes back if none is. */
async function allowance(userId: string, now: Date): Promise<{ left: number; limited?: Limited }> {
  const { count, oldest } = await requestedToday(userId, now);
  const left = Math.max(CHATGPT_STORIES_PER_DAY - count, 0);
  if (left > 0) return { left };
  return {
    left,
    limited: { outcome: 'limited', left: 0, retryAt: new Date((oldest ?? now).getTime() + DAY_MS) },
  };
}

type RequestDeps = { via: StoryRequestVia; safety?: SafetyCheck; now?: Date };

/**
 * Queues a story for each situation, as many as today allows, in order.
 * Each is moderated first, as a reborn answer is: a flagged one is not kept at
 * all. If moderation can't be reached, the story is queued anyway, since
 * everything written from it is moderated again before it can be played.
 * Stories asked for together share a batch, so the player is told once when
 * they're ready (`announceStoryReady`).
 */
export async function requestStories(
  userId: string,
  contexts: ChatGPTContext[],
  { via, safety = getSafetyCheck(), now = new Date() }: RequestDeps
): Promise<StoriesRequest> {
  const tracked = (outcome: 'queued' | 'limited' | 'flagged', stories: number) =>
    track(userId, { name: 'chatgpt_story_requested', properties: { outcome, via, stories } });

  const { left, limited } = await allowance(userId, now);
  if (limited) {
    await tracked('limited', 0);
    return limited;
  }

  const taken = contexts.slice(0, left);
  const kept: ChatGPTContext[] = [];
  for (const context of taken) {
    let flagged = false;
    try {
      ({ flagged } = await safety(contextText(context)));
    } catch {
      flagged = false;
    }
    if (!flagged) kept.push(context);
  }
  if (kept.length === 0) {
    await tracked('flagged', 0);
    return { outcome: 'flagged' };
  }

  const batchId = kept.length > 1 ? crypto.randomUUID() : null;
  const storyIds = await db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const context of kept) ids.push(await enqueueForContext(tx, userId, context, batchId));
    return ids;
  });
  await tracked('queued', storyIds.length);
  return {
    outcome: 'queued',
    storyIds,
    left: left - storyIds.length,
    overLimit: contexts.length - taken.length,
    flagged: taken.length - kept.length,
  };
}

/** `requestStories` for one: what `write_my_story` sends. */
export async function requestStory(
  userId: string,
  context: ChatGPTContext,
  deps: Omit<RequestDeps, 'via'> & { via?: StoryRequestVia } = {}
): Promise<StoryRequest> {
  const result = await requestStories(userId, [context], { via: 'mcp', ...deps });
  return result.outcome === 'queued'
    ? { outcome: 'queued', storyId: result.storyIds[0], left: result.left }
    : result;
}

export type LinkRequest =
  | { outcome: 'queued'; stories: number; left: number; overLimit: number }
  | Limited
  /** Nothing in the link to write a story from: no situation, or only ones that were dropped. */
  | { outcome: 'not_written'; reason: Extract<ChatGPTStoryReason, 'not_a_story' | 'unsafe'> };

/**
 * Stories from a link ChatGPT wrote (`/open/story#…`), sent by the iPhone app:
 * one note with up to five situations in it.
 *
 * `chatgpt.situations` sorts the note into situations first, dropping what is
 * sensitive or too thin whatever ChatGPT put in it, and only those situations
 * are kept, never the note. Then each is queued exactly as `write_my_story`
 * queues one. Today's allowance is checked before the model is paid for.
 */
export async function requestStoriesFromLink(
  userId: string,
  note: string,
  {
    generator = getGenerator(),
    signal,
    ...deps
  }: Omit<RequestDeps, 'via'> & { generator?: Generator; signal?: AbortSignal } = {}
): Promise<LinkRequest> {
  const via = 'link' as const;
  const now = deps.now ?? new Date();
  const { limited } = await allowance(userId, now);
  if (limited) {
    await track(userId, {
      name: 'chatgpt_story_requested',
      properties: { outcome: 'limited', via, stories: 0 },
    });
    return limited;
  }

  const { value } = await withDeadline(
    (deadline) => generator.run(situationsPrompt, { text: note }, { signal: deadline }),
    TURN_DEADLINE_MS,
    signal
  );
  // A situation that doesn't fit what `write_my_story` takes is dropped, not fixed.
  const situations = value.situations.slice(0, MAX_LINK_SITUATIONS).flatMap((situation) => {
    const parsed = chatgptContextSchema.safeParse(situation);
    return parsed.success ? [parsed.data] : [];
  });
  if (situations.length === 0) {
    await track(userId, {
      name: 'chatgpt_story_requested',
      properties: { outcome: 'not_written', via, stories: 0 },
    });
    return { outcome: 'not_written', reason: 'not_a_story' };
  }

  const result = await requestStories(userId, situations, { ...deps, now, via });
  switch (result.outcome) {
    case 'queued':
      return {
        outcome: 'queued',
        stories: result.storyIds.length,
        left: result.left,
        overLimit: result.overLimit,
      };
    case 'limited':
      return result;
    case 'flagged':
      return { outcome: 'not_written', reason: 'unsafe' };
  }
}

/**
 * "your story's ready.": once, when a story asked for in ChatGPT has been
 * written, to a player with notifications on. For stories asked for together
 * (one link), once for the batch, when the first is written: a later one is
 * quiet. Two finishing in the same instant can each send it; none is missed. The text names no one. Called by
 * the pool job; it never throws, because the story is written either way.
 */
export async function announceStoryReady(templateId: string): Promise<void> {
  if (env.PUSH_ENABLED !== 'true' || !apnsConfigured()) return;
  try {
    const userId = await storyReadyRecipient(templateId);
    if (!userId) return;
    const sent = await sendToUser(userId, MESSAGES.story_ready, 'story_ready');
    if (sent.delivered > 0) {
      await withIosClient(() =>
        track(userId, { name: 'push_sent', properties: { kind: 'story_ready' } })
      );
    }
  } catch {
    // A notification that didn't go is not worth failing a written story over.
  }
}

/**
 * Who to tell that this story is ready, or null: a `chatgpt` story whose
 * player has notifications on, and, for stories asked for together, the first
 * of them to be ready.
 */
export async function storyReadyRecipient(templateId: string): Promise<string | null> {
  const [row] = await db
    .select({
      userId: users.id,
      earlierInBatch: sql<boolean>`exists (
        select 1 from "story_templates" "b"
        where "b"."batch_id" = "story_templates"."batch_id"
          and "b"."id" <> "story_templates"."id"
          and "b"."status" = 'ready'
          and ("b"."updated_at", "b"."id") < ("story_templates"."updated_at", "story_templates"."id")
      )`,
    })
    .from(storyTemplates)
    .innerJoin(users, eq(users.id, storyTemplates.userId))
    .where(
      and(
        eq(storyTemplates.id, templateId),
        eq(storyTemplates.origin, 'chatgpt'),
        eq(storyTemplates.status, 'ready'),
        eq(users.pushEnabled, true)
      )
    )
    .limit(1);
  return row && !row.earlierInBatch ? row.userId : null;
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
