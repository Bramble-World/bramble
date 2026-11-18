import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '@/index';
import { chatgptContexts, persons, storylines, storyTemplates, users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import type { ChatGPTContext } from '@/lib/chatgpt/context';
import { SEED_STORIES } from '@/lib/pool/seeds';
import { advanceSession, commitChoice } from '../generation/turns.service';
import * as sessions from '../sessions/sessions.service';
import { claimNextTemplate } from '../pool/pool.writer';
import { runTemplate } from '../pool/pool.job';
import { instantiateTemplate, nextStoryFor, startNextStory } from '../pool/next.service';
import {
  CHATGPT_STORIES_PER_DAY,
  chatgptStatus,
  deleteStory,
  listStories,
  markConnected,
  requestStory,
} from './chatgpt.service';

/**
 * Bramble in ChatGPT end to end against a real database and the fake model:
 * what ChatGPT sends becomes the player's own story, keeps the names, is
 * forgotten once written, comes next on their iPhone, and never reaches anyone
 * else.
 */

const CLERK = 'user_chatgpt_';
const SEED_SLUG = 'chatgpt-test-seed';
/** A second seed, so there is a pool story left to offer after the first is played. */
const OTHER_SEED_SLUG = 'chatgpt-test-seed-2';
const pass = async () => ({ flagged: false });
const flag = async () => ({ flagged: true });

const CONTEXT: ChatGPTContext = {
  about:
    'my best friend Priya and I applied to the same summer program and only she got in. she keeps asking if we are ok and I keep saying yes.',
  people: [{ name: 'Priya', relationship: 'best friend', details: 'we met in seventh grade' }],
  you: 'a junior in high school',
};

let fake: FakeGenerator;
let seedId: string;

async function newUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ clerkId: `${CLERK}${name}`, email: `${name}@chatgpt.local` })
    .returning({ id: users.id });
  await db.insert(persons).values({ userId: user.id, name: 'You', isSelf: true });
  return user.id;
}

async function writeNext() {
  const claim = await claimNextTemplate(db);
  if (!claim) throw new Error('nothing to claim');
  return runTemplate(claim, { generator: fake, safety: pass });
}

async function contextsOf(userId: string) {
  return db.select().from(chatgptContexts).where(eq(chatgptContexts.userId, userId));
}

/** Plays a seed story to its ending, with a short budget so it ends at beat 2. */
async function finishAStory(userId: string) {
  const sessionId = await db.transaction((tx) =>
    instantiateTemplate(tx, userId, seedId, SEED_STORIES['close-friends'])
  );
  const session = await sessions.getSession(userId, sessionId);
  await db.update(storylines).set({ targetBeats: 6 }).where(eq(storylines.id, session.storylineId));
  const first = await advanceSession(userId, sessionId, { generator: fake });
  await commitChoice(userId, first.id, first.choices[0].id);
  const ending = await advanceSession(userId, sessionId, { generator: fake });
  expect(ending.isEnding).toBe(true);
  return sessionId;
}

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  await db.delete(storyTemplates).where(inArray(storyTemplates.slug, [SEED_SLUG, OTHER_SEED_SLUG]));
  const other = Object.entries(SEED_STORIES).find(([slug]) => slug !== 'close-friends')![1];
  await db.insert(storyTemplates).values({
    origin: 'seed',
    slug: OTHER_SEED_SLUG,
    status: 'ready',
    content: other,
  });
  const [seed] = await db
    .insert(storyTemplates)
    .values({
      origin: 'seed',
      slug: SEED_SLUG,
      status: 'ready',
      content: SEED_STORIES['close-friends'],
    })
    .returning({ id: storyTemplates.id });
  seedId = seed.id;
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  await db.delete(storyTemplates).where(inArray(storyTemplates.slug, [SEED_SLUG, OTHER_SEED_SLUG]));
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  fake = createFakeGenerator();
  registerFixtures(fake);
});

describe('writing a story from what ChatGPT sent', () => {
  it('queues it at once, and keeps what was sent until it is written', async () => {
    const player = await newUser('player');
    const result = await requestStory(player, CONTEXT, { safety: pass });
    expect(result).toMatchObject({ outcome: 'queued', left: CHATGPT_STORIES_PER_DAY - 1 });

    const [template] = await db
      .select()
      .from(storyTemplates)
      .where(eq(storyTemplates.userId, player));
    expect(template).toMatchObject({ origin: 'chatgpt', status: 'pending', attempts: 0 });
    expect(await contextsOf(player)).toHaveLength(1);
    expect(await chatgptStatus(player)).toEqual({ connected: false, writing: true });
  });

  it('writes a ready story that keeps the names, then forgets what was sent', async () => {
    const player = await newUser('player');
    await requestStory(player, CONTEXT, { safety: pass });

    expect(await writeNext()).toBe('ready');

    const [story] = await db.select().from(storyTemplates).where(eq(storyTemplates.userId, player));
    expect(story).toMatchObject({ status: 'ready', sourceContextId: null });
    expect(story.content!.cast.map((c) => c.name)).toContain('Priya');
    expect(await contextsOf(player)).toHaveLength(0);
    expect(fake.calls.map((c) => c.promptName)).toEqual(['personal.rewrite', 'personal.check']);
    expect(await listStories(player)).toMatchObject([
      { status: 'ready', title: story.content!.title },
    ]);
  });

  it('declines a thin one for good, and forgets it too', async () => {
    const player = await newUser('player');
    await requestStory(player, { ...CONTEXT, about: 'idk' }, { safety: pass });

    expect(await writeNext()).toBe('declined');
    const [story] = await db.select().from(storyTemplates).where(eq(storyTemplates.userId, player));
    expect(story).toMatchObject({ status: 'declined', reason: 'too_thin', content: null });
    expect(await contextsOf(player)).toHaveLength(0);
    expect(await listStories(player)).toMatchObject([{ status: 'not_written', title: null }]);
  });

  it('keeps nothing that moderation flags', async () => {
    const player = await newUser('player');
    expect(await requestStory(player, CONTEXT, { safety: flag })).toEqual({ outcome: 'flagged' });
    expect(await contextsOf(player)).toHaveLength(0);
    expect(await listStories(player)).toEqual([]);
  });

  it(`writes at most ${CHATGPT_STORIES_PER_DAY} a day`, async () => {
    const player = await newUser('player');
    for (let i = 0; i < CHATGPT_STORIES_PER_DAY; i++) {
      expect((await requestStory(player, CONTEXT, { safety: pass })).outcome).toBe('queued');
    }
    expect(await requestStory(player, CONTEXT, { safety: pass })).toEqual({
      outcome: 'limited',
      left: 0,
    });
  });

  it('records the connection once', async () => {
    const player = await newUser('player');
    await markConnected(player);
    const [first] = await db.select().from(users).where(eq(users.id, player));
    await markConnected(player);
    const [again] = await db.select().from(users).where(eq(users.id, player));
    expect(first.chatgptConnectedAt).not.toBeNull();
    expect(again.chatgptConnectedAt).toEqual(first.chatgptConnectedAt);
    expect((await chatgptStatus(player)).connected).toBe(true);
  });
});

describe('playing it on the iPhone', () => {
  it('comes next for its player, ahead of the pool', async () => {
    const player = await newUser('player');
    await requestStory(player, CONTEXT, { safety: pass });
    await writeNext();
    const ended = await finishAStory(player);

    const next = await nextStoryFor(player, ended);
    expect(next).toMatchObject({ origin: 'chatgpt', fromChatGPT: true, fromPool: false });

    const { sessionId } = await startNextStory(player, ended, { how: 'begin_now' });
    const session = await sessions.getSession(player, sessionId);
    const [copy] = await db.select().from(storylines).where(eq(storylines.id, session.storylineId));
    expect(copy.templateId).toBe(next!.templateId);
    expect(await listStories(player)).toMatchObject([{ status: 'playing' }]);
  });

  it('replaces a pool story already offered, once it is written', async () => {
    const player = await newUser('player');
    const ended = await finishAStory(player);
    expect((await nextStoryFor(player, ended))?.origin).toBe('seed');

    await requestStory(player, CONTEXT, { safety: pass });
    await writeNext();
    expect((await nextStoryFor(player, ended))?.origin).toBe('chatgpt');
  });

  it('is never offered to anyone else', async () => {
    const author = await newUser('author');
    await requestStory(author, CONTEXT, { safety: pass });
    await writeNext();

    const other = await newUser('other');
    const ended = await finishAStory(other);
    const next = await nextStoryFor(other, ended);
    expect(next?.origin).not.toBe('chatgpt');
  });
});

describe('deleting it', () => {
  it('removes the story, its copy and the people it brought in', async () => {
    const player = await newUser('player');
    const queued = await requestStory(player, CONTEXT, { safety: pass });
    if (queued.outcome !== 'queued') throw new Error('not queued');
    await writeNext();
    const ended = await finishAStory(player);
    await startNextStory(player, ended, { how: 'begin_now' });
    expect(
      await db
        .select()
        .from(persons)
        .where(and(eq(persons.userId, player), eq(persons.name, 'Priya')))
    ).toHaveLength(1);

    expect(await deleteStory(player, queued.storyId)).toBe(true);

    expect(await listStories(player)).toEqual([]);
    expect(
      await db.select().from(storylines).where(eq(storylines.templateId, queued.storyId))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(persons)
        .where(and(eq(persons.userId, player), eq(persons.name, 'Priya')))
    ).toHaveLength(0);
    // Their own self, and the story they finished, stay.
    expect(
      await db
        .select()
        .from(persons)
        .where(and(eq(persons.userId, player), eq(persons.isSelf, true)))
    ).toHaveLength(1);
  });

  it('removes what was sent along with a story still being written', async () => {
    const player = await newUser('player');
    const queued = await requestStory(player, CONTEXT, { safety: pass });
    if (queued.outcome !== 'queued') throw new Error('not queued');
    expect(await deleteStory(player, queued.storyId)).toBe(true);
    expect(await contextsOf(player)).toHaveLength(0);
  });

  it("won't delete someone else's", async () => {
    const author = await newUser('author');
    const queued = await requestStory(author, CONTEXT, { safety: pass });
    if (queued.outcome !== 'queued') throw new Error('not queued');
    const other = await newUser('other');
    expect(await deleteStory(other, queued.storyId)).toBe(false);
    expect(await listStories(author)).toHaveLength(1);
  });
});

describe('/api/mcp', () => {
  it('answers 401 with where to sign in, without a token', async () => {
    const { POST } = await import('@/app/api/mcp/route');
    const response = await POST(
      new Request('http://localhost:3000/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      undefined as never
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource/api/mcp'
    );
  });
});
