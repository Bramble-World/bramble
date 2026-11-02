import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

/** The sweep against a real database. Only Apple is stubbed. */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake', PUSH_ENABLED: 'true' } };
});
vi.mock('./apns', () => ({ apnsConfigured: () => true, sendPush: vi.fn() }));

const { env } = await import('@/env');
const { db } = await import('@/index');
const { pushDevices, pushSends, storyTurns, storylineSessions, users } =
  await import('@/db/schema/tables');
const apns = vi.mocked(await import('./apns'));
const storylines = await import('../storylines/storylines.service');
const { sweepPush } = await import('./push.sweep');

const CLERK = 'user_push_sweep';
const HOUR = 60 * 60 * 1000;
/** 15:00 in New York. */
const NOW = new Date('2026-11-04T20:00:00Z');

let userId: string;
let sessionId: string;

/** Answered, because a session can only have one open turn. */
async function addTurn(createdAt: Date, turnOrder: number) {
  const [{ id }] = await db
    .insert(storyTurns)
    .values({ sessionId, turnOrder, narrativeContent: 'x', createdAt, selectedChoiceId: null })
    .returning({ id: storyTurns.id });
  const [choice] = await db
    .insert(turnChoices)
    .values({ turnId: id, label: 'x', orderIndex: 0 })
    .returning({ id: turnChoices.id });
  await db.update(storyTurns).set({ selectedChoiceId: choice.id }).where(eq(storyTurns.id, id));
}

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
  [{ id: userId }] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'push-sweep@test.local' })
    .returning({ id: users.id });
  const storyline = await storylines.createStoryline(userId, {
    title: 'A story',
    sourceSurface: 'imessage',
    tone: 'wistful',
  });
  [{ id: sessionId }] = await db
    .insert(storylineSessions)
    .values({ storylineId: storyline.id, userId })
    .returning({ id: storylineSessions.id });
  await db.insert(pushDevices).values({
    userId,
    token: 'ef'.repeat(32),
    environment: 'production',
    timeZone: 'America/New_York',
    lastSeenAt: new Date(NOW.getTime() - 30 * HOUR),
  });
});

beforeEach(async () => {
  await db.delete(pushSends).where(eq(pushSends.userId, userId));
  await db.delete(storyTurns).where(eq(storyTurns.sessionId, sessionId));
  await db.update(users).set({ pushEnabled: true }).where(eq(users.id, userId));
  (env as { PUSH_ENABLED?: string }).PUSH_ENABLED = 'true';
  apns.sendPush.mockReset();
  apns.sendPush.mockResolvedValue({ kind: 'delivered' });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, [CLERK]));
});

const sent = () => db.select().from(pushSends).where(eq(pushSends.userId, userId));

describe('sweepPush', () => {
  it('sends what is due, once however often it runs', async () => {
    await addTurn(new Date(NOW.getTime() - 30 * HOUR), 1);

    expect(await sweepPush(NOW)).toMatchObject({ delivered: 1 });
    expect(await sweepPush(NOW)).toMatchObject({ delivered: 0 });

    expect(apns.sendPush).toHaveBeenCalledOnce();
    expect(await sent()).toMatchObject([{ kind: 'story_waiting', ordinal: 0 }]);
  });

  it('tells the battery from a story waiting', async () => {
    for (let i = 0; i < 20; i += 1) {
      await addTurn(new Date(NOW.getTime() - (30 + i * 0.1) * HOUR), i + 1);
    }
    await sweepPush(NOW);
    expect(await sent()).toMatchObject([{ kind: 'battery_back' }]);
  });

  it('counts nothing when nothing arrived, so the next run tries again', async () => {
    await addTurn(new Date(NOW.getTime() - 30 * HOUR), 1);
    apns.sendPush.mockResolvedValueOnce({ kind: 'failed', reason: 'TooManyRequests' });

    expect(await sweepPush(NOW)).toMatchObject({ undelivered: 1 });
    expect(await sent()).toEqual([]);
    expect(await sweepPush(NOW)).toMatchObject({ delivered: 1 });
  });

  it('respects the switch in settings', async () => {
    await addTurn(new Date(NOW.getTime() - 30 * HOUR), 1);
    await db.update(users).set({ pushEnabled: false }).where(eq(users.id, userId));

    await sweepPush(NOW);
    expect(apns.sendPush).not.toHaveBeenCalled();
  });

  it('does nothing unless PUSH_ENABLED is true', async () => {
    await addTurn(new Date(NOW.getTime() - 30 * HOUR), 1);
    (env as { PUSH_ENABLED?: string }).PUSH_ENABLED = undefined;

    expect(await sweepPush(NOW)).toEqual({ due: 0, delivered: 0, undelivered: 0 });
    expect(apns.sendPush).not.toHaveBeenCalled();
  });
});
