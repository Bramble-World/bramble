import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * The story texts you, against a real database and the fake generator: a beat
 * that pauses, the answer that sets the reply's due time, the turn refused
 * until then, and the sweep that writes the reply and announces it. Only Apple
 * is stubbed.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return {
    env: { ...actual.env, BRAMBLE_AI_MODE: 'fake', PUSH_ENABLED: 'true', PAUSES_ROLLOUT: 'admins' },
  };
});
vi.mock('../push/apns', () => ({ apnsConfigured: () => true, sendPush: vi.fn() }));

const { db } = await import('@/index');
const { pushDevices, pushSends, storyTurns, storylineSessions, turnChoices, users } =
  await import('@/db/schema/tables');
const { ReplyPendingError } = await import('@/lib/utils/errors');
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');
const apns = vi.mocked(await import('../push/apns'));
const persons = await import('../persons/persons.service');
const storylines = await import('../storylines/storylines.service');
const sessions = await import('../sessions/sessions.service');
const timeline = await import('../timeline/timeline.service');
const { advanceSession, commitChoice } = await import('./turns.service');
const { sweepReplies } = await import('./reply.sweep');
const { PAUSE_MIN_BEATS } = await import('./pauses');

const ADMIN = 'user_pauses_admin';
const PLAYER = 'user_pauses_player';
/** 15:00 in New York, so the sweep isn't in anyone's quiet hours. */
const AFTERNOON = new Date('2026-11-25T20:00:00Z');
const MINUTE = 60 * 1000;

let adminId: string;
let playerId: string;
let storylineId: string;
let playerStorylineId: string;
let fake: ReturnType<typeof createFakeGenerator>;

async function storyFor(userId: string): Promise<string> {
  const storyline = await storylines.createStoryline(userId, {
    title: 'A story',
    sourceSurface: 'imessage',
    tone: 'wistful',
  });
  await storylines.markStatus(userId, storyline.id, 'ready');
  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  const maya = await persons.createPerson(userId, { name: 'Maya' });
  const a = await storylines.castCharacter(userId, storyline.id, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storyline.id, maya.id);
  await storylines.relateCharacters(userId, storyline.id, a.id, b.id, { closeness: 'was close' });
  await timeline.appendEvent(userId, storyline.id, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in three weeks.',
    participantCharacterIds: [a.id, b.id],
  });
  return storyline.id;
}

/** Plays beats until one pauses, or `max` are played; returns the paused one, answered. */
async function playToPause(sessionId: string, max = PAUSE_MIN_BEATS + 2, pauses = true) {
  for (let i = 0; i < max; i += 1) {
    // As from iOS build 40 and later, the only app the route lets pause.
    const turn = await advanceSession(adminId, sessionId, { generator: fake, pauses });
    await commitChoice(adminId, turn.id, turn.choices[0].id);
    const [row] = await db
      .select({ replyLater: storyTurns.replyLater })
      .from(storyTurns)
      .where(eq(storyTurns.id, turn.id));
    if (row.replyLater) return { turn, beat: i + 1, kind: row.replyLater };
  }
  return null;
}

const sessionRow = async (id: string) =>
  (await db.select().from(storylineSessions).where(eq(storylineSessions.id, id)))[0];

beforeAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, [ADMIN, PLAYER]));
  [{ id: adminId }] = await db
    .insert(users)
    .values({ clerkId: ADMIN, email: 'admin@pauses.local', role: 'admin' })
    .returning({ id: users.id });
  [{ id: playerId }] = await db
    .insert(users)
    .values({ clerkId: PLAYER, email: 'player@pauses.local' })
    .returning({ id: users.id });
  storylineId = await storyFor(adminId);
  playerStorylineId = await storyFor(playerId);
  await db.insert(pushDevices).values({
    userId: adminId,
    token: 'ab'.repeat(32),
    environment: 'production',
    timeZone: 'America/New_York',
    lastSeenAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, [ADMIN, PLAYER]));
});

beforeEach(async () => {
  fake = createFakeGenerator();
  registerFixtures(fake);
  await db.delete(storylineSessions).where(inArray(storylineSessions.userId, [adminId, playerId]));
  apns.sendPush.mockReset();
  apns.sendPush.mockResolvedValue({ kind: 'delivered' });
});

describe('a story that pauses', () => {
  it('pauses only once the reader has played a good session, and stores why', async () => {
    const session = await sessions.startSession(adminId, storylineId);
    const paused = await playToPause(session.id);

    expect(paused?.beat).toBe(PAUSE_MIN_BEATS + 1);
    expect(paused?.kind).toBe('soon');
  });

  it('sets the reply due on the answer, and refuses the next beat until then', async () => {
    const session = await sessions.startSession(adminId, storylineId);
    const before = Date.now();
    await playToPause(session.id);

    const row = await sessionRow(session.id);
    expect(row.replyDueKind).toBe('soon');
    const wait = row.replyDueAt!.getTime() - before;
    expect(wait).toBeGreaterThan(29 * MINUTE);

    await expect(advanceSession(adminId, session.id, { generator: fake })).rejects.toBeInstanceOf(
      ReplyPendingError
    );
    const turns = await db
      .select({ id: storyTurns.id })
      .from(storyTurns)
      .where(eq(storyTurns.sessionId, session.id));
    expect(turns).toHaveLength(PAUSE_MIN_BEATS + 1);
  });

  it("never pauses for an app that can't show it", async () => {
    const session = await sessions.startSession(adminId, storylineId);
    expect(await playToPause(session.id, PAUSE_MIN_BEATS + 2, false)).toBeNull();
  });

  it('pauses at most once a day', async () => {
    const first = await sessions.startSession(adminId, storylineId);
    await playToPause(first.id);
    const second = await sessions.startSession(adminId, storylineId);
    expect(await playToPause(second.id, 3)).toBeNull();
  });
});

describe('the reply sweep', () => {
  async function due(sessionId: string, at = new Date(AFTERNOON.getTime() - MINUTE)) {
    await db
      .update(storylineSessions)
      .set({ replyDueAt: at, replyDueKind: 'soon' })
      .where(eq(storylineSessions.id, sessionId));
  }

  it('writes the reply once it is due, announces it once, and clears it', async () => {
    const session = await sessions.startSession(adminId, storylineId);
    await playToPause(session.id);
    await due(session.id);

    expect(await sweepReplies({ generator: fake, now: AFTERNOON })).toMatchObject({
      due: 1,
      written: 1,
      notified: 1,
    });
    expect(apns.sendPush).toHaveBeenCalledOnce();
    const message = apns.sendPush.mock.calls[0][1];
    expect(message.title).toMatch(/new texts? in your story\.|waiting on your choice/);
    expect(JSON.stringify(message)).not.toContain('Maya');

    expect((await sessionRow(session.id)).replyDueAt).toBeNull();
    const sends = await db
      .select()
      .from(pushSends)
      .where(and(eq(pushSends.userId, adminId), eq(pushSends.kind, 'reply_arrived')));
    expect(sends).toHaveLength(1);

    expect(await sweepReplies({ generator: fake, now: AFTERNOON })).toMatchObject({ due: 0 });
    expect(apns.sendPush).toHaveBeenCalledOnce();
  });

  it('waits for the morning in the reader’s quiet hours', async () => {
    const session = await sessions.startSession(adminId, storylineId);
    await playToPause(session.id);
    // 03:00 in New York.
    const night = new Date('2026-11-26T08:00:00Z');
    await due(session.id, new Date(night.getTime() - MINUTE));

    expect(await sweepReplies({ generator: fake, now: night })).toMatchObject({
      due: 1,
      quiet: 1,
      written: 0,
    });
    expect((await sessionRow(session.id)).replyDueAt).not.toBeNull();
  });

  it('waits for battery, and writes nothing meanwhile', async () => {
    const session = await sessions.startSession(playerId, playerStorylineId);
    // A full day's battery already spent: twenty answered beats in the last day.
    for (let order = 1; order <= 20; order += 1) {
      const [{ id }] = await db
        .insert(storyTurns)
        .values({ sessionId: session.id, turnOrder: order, narrativeContent: 'x' })
        .returning({ id: storyTurns.id });
      const [choice] = await db
        .insert(turnChoices)
        .values({ turnId: id, label: 'x', orderIndex: 0 })
        .returning({ id: turnChoices.id });
      await db.update(storyTurns).set({ selectedChoiceId: choice.id }).where(eq(storyTurns.id, id));
    }
    await due(session.id);

    expect(await sweepReplies({ generator: fake, now: AFTERNOON })).toMatchObject({
      due: 1,
      noBattery: 1,
      written: 0,
    });
    expect(apns.sendPush).not.toHaveBeenCalled();
  });
});
