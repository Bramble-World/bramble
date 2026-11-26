import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * `POST /api/v1/stories/from-chatgpt` over its real handler: the fake model
 * sorts the note (one situation per paragraph) and moderation passes, as with
 * no key.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});
vi.mock('@/lib/services/auth/auth.service', () => ({ requireCurrentUser: vi.fn() }));

const { db } = await import('@/index');
const { chatgptContexts, storyTemplates, users } = await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const { UnauthorizedError } = await import('@/lib/utils/errors');
const { CHATGPT_STORIES_PER_DAY } = await import('@/lib/services/chatgpt/chatgpt.service');
const route = await import('@/app/api/v1/stories/from-chatgpt/route');

const CLERK = 'user_story_link_';
const NOTE = [
  'my ex Jordan texted me happy birthday after six months of nothing and I never answered.',
  'my best friend Priya got into the summer program and I did not, and we have not talked about it.',
].join('\n\n');

let player: string;

const post = (body: unknown) =>
  route.POST(
    new Request('http://api.test/api/v1/stories/from-chatgpt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    undefined as never
  );
const as = (id: string, isGuest = false) =>
  auth.requireCurrentUser.mockResolvedValue({ id, isGuest } as never);
const templatesOf = (userId: string) =>
  db.select().from(storyTemplates).where(eq(storyTemplates.userId, userId));

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  [{ id: player }] = await db
    .insert(users)
    .values({ clerkId: `${CLERK}player`, email: 'player@story-link.local' })
    .returning({ id: users.id });
  auth.requireCurrentUser.mockReset();
  as(player);
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

describe('POST /api/v1/stories/from-chatgpt', () => {
  it('queues a story for each situation in the note: 202', async () => {
    const response = await post({ context: `  ${NOTE}  ` });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      outcome: 'queued',
      stories: 2,
      left: CHATGPT_STORIES_PER_DAY - 2,
      overLimit: 0,
    });
    const templates = await templatesOf(player);
    expect(templates).toHaveLength(2);
    expect(templates.every((t) => t.origin === 'chatgpt' && t.status === 'pending')).toBe(true);
    // Only the situations are kept, never the note.
    const kept = await db.select().from(chatgptContexts).where(eq(chatgptContexts.userId, player));
    expect(kept.map((c) => c.content.about)).not.toContain(NOTE);
  });

  it('says so when there is nothing to make a story from: 200 not_written', async () => {
    const response = await post({ context: 'idk' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'not_written', reason: 'not_a_story' });
    expect(await templatesOf(player)).toEqual([]);
  });

  it('is 429 RATE_LIMITED with Retry-After once the day is used up', async () => {
    await db.insert(storyTemplates).values(
      Array.from({ length: CHATGPT_STORIES_PER_DAY }, () => ({
        origin: 'chatgpt' as const,
        userId: player,
        status: 'pending' as const,
      }))
    );
    const response = await post({ context: NOTE });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(24 * 60 * 60 - 60);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(body.error.retryAfter).toBe(retryAfter);
  });

  it('refuses an empty note, a blank one and one over 6000 characters: 400', async () => {
    for (const context of [undefined, '', '   \n ', 'x'.repeat(6001)]) {
      const response = await post({ context });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    expect(await templatesOf(player)).toEqual([]);
    // At the limit it's taken: what becomes of it is the model's (with the
    // fake, one long situation, trimmed to fit and queued).
    expect((await post({ context: 'x'.repeat(6000) })).status).not.toBe(400);
  });

  it('refuses a guest: 403 SIGNUP_REQUIRED', async () => {
    as(player, true);
    const response = await post({ context: NOTE });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('SIGNUP_REQUIRED');
    expect(await templatesOf(player)).toEqual([]);
  });

  it('refuses a request without a valid token: 401', async () => {
    auth.requireCurrentUser.mockRejectedValue(new UnauthorizedError());
    const response = await post({ context: NOTE });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });
});
