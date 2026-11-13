import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '@/index';
import { persons, storylines, storylineSessions, storyTemplates, users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { checkPrompt, rewritePrompt } from '@/lib/ai/prompts/pool.prompt';
import { SEED_STORIES } from '@/lib/pool/seeds';
import { templateText } from '@/lib/pool/template';
import { ConflictError, RateLimitError } from '@/lib/utils/errors';
import { energyFor } from '../sessions/energy.service';
import { saveRebornAnswer, withdrawRebornAnswer } from '../onboarding/reborn-answers.service';
import { advanceSession, commitChoice } from '../generation/turns.service';
import * as sessions from '../sessions/sessions.service';
import { claimNextTemplate, MAX_TEMPLATE_ATTEMPTS } from './pool.writer';
import { runTemplate } from './pool.job';
import { instantiateTemplate, nextStoryFor, startNextStory } from './next.service';

/**
 * The pool end to end against a real database and the fake model: an answer
 * becomes a story, the story reaches another player when theirs ends, and the
 * author leaving takes it out of the pool and out of nobody's hands.
 */

const CLERK = 'user_pool_';
const SEED_SLUG = 'pool-test-seed';
const pass = async () => ({ flagged: false });
const ANSWER = 'my piano teacher Mrs Adeyemi told me to apply to the conservatory in Leeds';

let fake: FakeGenerator;

async function newUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ clerkId: `${CLERK}${name}`, email: `${name}@pool.local` })
    .returning({ id: users.id });
  await db.insert(persons).values({ userId: user.id, name: 'You', isSelf: true });
  return user.id;
}

async function templatesOf(userId: string) {
  return db.select().from(storyTemplates).where(eq(storyTemplates.userId, userId));
}

/** Makes every pending template claimable now, skipping the settle wait. */
async function settle() {
  await db
    .update(storyTemplates)
    .set({ nextAttemptAt: null })
    .where(eq(storyTemplates.status, 'pending'));
}

async function writeNext() {
  await settle();
  const claim = await claimNextTemplate(db);
  if (!claim) throw new Error('nothing to claim');
  return runTemplate(claim, { generator: fake, safety: pass });
}

/** Plays a pool story to its ending, with a short budget so it ends at beat 2. */
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

let seedId: string;

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  await db.delete(storyTemplates).where(eq(storyTemplates.slug, SEED_SLUG));
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
  await db.delete(storyTemplates).where(eq(storyTemplates.slug, SEED_SLUG));
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  fake = createFakeGenerator();
  registerFixtures(fake);
});

describe('writing stories from answers', () => {
  it('queues a story when an answer is saved, after a settle wait', async () => {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);

    const [queued] = await templatesOf(author);
    expect(queued).toMatchObject({ origin: 'reborn', status: 'pending', attempts: 0 });
    expect(queued.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // Not before the wait.
    expect(await claimNextTemplate(db)).toBeNull();
  });

  it('writes a ready story that shares nothing with the answer', async () => {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);

    expect(await writeNext()).toBe('ready');

    const [story] = await templatesOf(author);
    expect(story).toMatchObject({ status: 'ready', qualityScore: 4, reason: null });
    const text = templateText(story.content!).toLowerCase();
    for (const word of ['adeyemi', 'leeds', 'conservatory', 'piano'])
      expect(text).not.toContain(word);
    // The writer and the checker both saw the answer; nothing else did.
    expect(fake.calls.map((c) => c.promptName)).toEqual(['pool.rewrite', 'pool.check']);
  });

  it('declines a thin answer, for good and without checking it', async () => {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 3, role: null, text: 'idk' }, pass);

    expect(await writeNext()).toBe('declined');
    const [story] = await templatesOf(author);
    expect(story).toMatchObject({ status: 'declined', reason: 'too_thin', content: null });
    expect(fake.calls.map((c) => c.promptName)).toEqual(['pool.rewrite']);
    expect(await claimNextTemplate(db)).toBeNull();
  });

  it('keeps out a story the check scores below the bar, and the score with it', async () => {
    const author = await newUser('author');
    fake.register(checkPrompt, () => ({
      verdict: 'pass' as const,
      rejectCode: null,
      qualityScore: 3,
    }));
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);

    expect(await writeNext()).toBe('rejected');
    const [story] = await templatesOf(author);
    expect(story).toMatchObject({
      status: 'rejected',
      reason: 'low_quality',
      qualityScore: 3,
      content: null,
    });
  });

  it('keeps out a story the check finds an identifier in', async () => {
    const author = await newUser('author');
    fake.register(checkPrompt, () => ({
      verdict: 'reject' as const,
      rejectCode: 'identifier' as const,
      qualityScore: 5,
    }));
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);

    expect(await writeNext()).toBe('rejected');
    expect((await templatesOf(author))[0]).toMatchObject({ reason: 'identifier', content: null });
  });

  it('keeps out a story moderation flags', async () => {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);
    await settle();
    const claim = (await claimNextTemplate(db))!;

    const outcome = await runTemplate(claim, {
      generator: fake,
      safety: async () => ({ flagged: true }),
    });

    expect(outcome).toBe('rejected');
    expect((await templatesOf(author))[0]).toMatchObject({ reason: 'moderation' });
  });

  it('retries a failure, then gives up after the last attempt', async () => {
    const author = await newUser('author');
    fake.register(rewritePrompt, () => {
      throw new Error('upstream down');
    });
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);

    for (let attempt = 1; attempt <= MAX_TEMPLATE_ATTEMPTS; attempt++) {
      expect(await writeNext()).toBe(attempt < MAX_TEMPLATE_ATTEMPTS ? 'retrying' : 'failed');
    }
    expect((await templatesOf(author))[0]).toMatchObject({
      status: 'failed',
      reason: 'generation_failed',
    });
  });

  it('replaces the story when the answer changes, and drops it when withdrawn', async () => {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);
    await writeNext();
    const [first] = await templatesOf(author);

    await saveRebornAnswer(author, { question: 1, role: null, text: `${ANSWER}, and i did` }, pass);
    const [second] = await templatesOf(author);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');

    await withdrawRebornAnswer(author, 1);
    expect(await templatesOf(author)).toEqual([]);
  });
});

describe('the next story', () => {
  async function authorWithStory() {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);
    await writeNext();
    return { author, templateId: (await templatesOf(author))[0].id };
  }

  it('offers nothing while a story is going', async () => {
    const player = await newUser('player');
    const sessionId = await db.transaction((tx) =>
      instantiateTemplate(tx, player, seedId, SEED_STORIES['close-friends'])
    );

    expect(await nextStoryFor(player, sessionId)).toBeNull();
    await expect(startNextStory(player, sessionId, { how: 'countdown' })).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it("offers another player's story first, and the same one every time", async () => {
    const { templateId } = await authorWithStory();
    const player = await newUser('player');
    const ended = await finishAStory(player);

    const offered = await nextStoryFor(player, ended);
    expect(offered).toMatchObject({ templateId, origin: 'reborn' });
    expect(await nextStoryFor(player, ended)).toEqual(offered);
  });

  it("copies it into the player's own world, and starts it once", async () => {
    const { templateId } = await authorWithStory();
    const player = await newUser('player');
    const ended = await finishAStory(player);

    const started = await startNextStory(player, ended, { how: 'countdown' });
    expect(await startNextStory(player, ended, { how: 'begin_now' })).toEqual(started);

    const next = await sessions.getSession(player, started.sessionId);
    const [copy] = await db.select().from(storylines).where(eq(storylines.id, next.storylineId));
    expect(copy).toMatchObject({ userId: player, templateId, status: 'ready' });
    const snapshot = await sessions.sessionSnapshot(player, started.sessionId);
    expect(snapshot.state).toBe('awaiting_turn');
  });

  it('never offers a player their own story, or one they have played', async () => {
    const { author, templateId } = await authorWithStory();
    const ended = await finishAStory(author);

    const offered = await nextStoryFor(author, ended);
    expect(offered?.templateId).not.toBe(templateId);
    // The seed they just finished is played, so it is not offered either.
    expect(offered?.templateId).not.toBe(seedId);
  });

  it("takes the story out of the pool when its author leaves, and leaves players' copies", async () => {
    const { author, templateId } = await authorWithStory();
    const player = await newUser('player');
    const ended = await finishAStory(player);
    const started = await startNextStory(player, ended, { how: 'countdown' });

    await db.delete(users).where(eq(users.id, author));

    expect(await db.select().from(storyTemplates).where(eq(storyTemplates.id, templateId))).toEqual(
      []
    );
    const next = await sessions.getSession(player, started.sessionId);
    const [copy] = await db.select().from(storylines).where(eq(storylines.id, next.storylineId));
    expect(copy).toMatchObject({ userId: player, templateId: null });
    // The copy's people are the player's.
    const cast = await db
      .select({ userId: persons.userId })
      .from(persons)
      .where(and(eq(persons.userId, player), eq(persons.isSelf, false)));
    expect(cast.length).toBeGreaterThan(0);
  });

  it('chooses again when the offered story has left the pool', async () => {
    const { author } = await authorWithStory();
    const player = await newUser('player');
    const ended = await finishAStory(player);
    await nextStoryFor(player, ended);

    await db.delete(users).where(eq(users.id, author));

    const [row] = await db
      .select({ next: storylineSessions.nextTemplateId })
      .from(storylineSessions)
      .where(inArray(storylineSessions.id, [ended]));
    expect(row.next).toBeNull();
    const offered = await nextStoryFor(player, ended);
    expect(offered?.origin ?? 'seed').toBe('seed');
  });
});

describe('the next-story card', () => {
  it("says a player's story is from someone else's past, with its hook and lines", async () => {
    const author = await newUser('author');
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);
    await writeNext();
    const player = await newUser('player');
    const ended = await finishAStory(player);

    const offered = await nextStoryFor(player, ended);

    expect(offered?.fromPool).toBe(true);
    expect(offered?.hook.length).toBeGreaterThan(0);
    expect(offered?.openingLines).toHaveLength(3);
    for (const line of offered!.openingLines) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(line).toBe(line.toLowerCase());
    }
  });

  it('keeps out a story whose hook gives away its opening', async () => {
    const author = await newUser('author');
    fake.register(checkPrompt, () => ({
      verdict: 'reject' as const,
      rejectCode: 'spoils_opening' as const,
      qualityScore: 5,
    }));
    await saveRebornAnswer(author, { question: 1, role: null, text: ANSWER }, pass);

    expect(await writeNext()).toBe('rejected');
    expect((await templatesOf(author))[0]).toMatchObject({ reason: 'spoils_opening' });
  });
});

describe('the first beat of the next story', () => {
  async function startedNext(player: string) {
    const ended = await finishAStory(player);
    return (await startNextStory(player, ended, { how: 'countdown' })).sessionId;
  }

  it('is free, and the beat after it is not', async () => {
    const player = await newUser('player');
    const next = await startedNext(player);
    const before = (await energyFor(player)).remaining;

    const first = await advanceSession(player, next, { generator: fake });
    expect((await energyFor(player)).remaining).toBe(before);

    await commitChoice(player, first.id, first.choices[0].id);
    await advanceSession(player, next, { generator: fake });
    expect((await energyFor(player)).remaining).toBe(before - 1);
  });

  it('still waits for battery', async () => {
    const player = await newUser('player');
    const next = await startedNext(player);
    // Spend what's left in another story, so the battery is at 0%.
    const other = await db.transaction((tx) =>
      instantiateTemplate(tx, player, seedId, SEED_STORIES['the-account'])
    );
    while ((await energyFor(player)).remaining > 0) {
      const turn = await advanceSession(player, other, { generator: fake, endings: false });
      await commitChoice(player, turn.id, turn.choices[0].id);
    }

    await expect(advanceSession(player, next, { generator: fake })).rejects.toBeInstanceOf(
      RateLimitError
    );
  });
});
