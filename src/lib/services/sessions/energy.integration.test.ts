import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '@/index';
import { storylineSessions, storyTurns, users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { RateLimitError } from '@/lib/utils/errors';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from './sessions.service';
import * as timeline from '../timeline/timeline.service';
import { advanceSession, commitChoice, generateTurn } from '../generation/turns.service';
import { ENERGY_WINDOW_MS, TURN_ENERGY_PER_DAY, energyFor } from './energy.service';

/**
 * The daily allowance on the one endpoint that spends money.
 *
 * Energy is derived from `story_turns` rather than stored, so these tests move
 * rows' `created_at` backwards instead of waiting — which is also the only
 * honest way to test a 24-hour window.
 */
const CLERK = 'user_energy_owner';
let userId: string;
let storylineId: string;
let fake: FakeGenerator;

/** Backdates every turn this reader owns, as if time had passed. */
async function ageAllTurnsBy(ms: number) {
  await db.execute(sql`
    update story_turns t
    set created_at = t.created_at - ${sql.raw(`interval '${Math.round(ms / 1000)} seconds'`)}
    from storyline_sessions s
    where s.id = t.session_id and s.user_id = ${userId}
  `);
}

/** Plays and answers one turn, so the next call needs a fresh generation. */
async function playOneTurn(sessionId: string) {
  const turn = await advanceSession(userId, sessionId, { generator: fake });
  await commitChoice(userId, turn.id, turn.choices[0].id);
  return turn;
}

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@energy.local' })
    .returning({ id: users.id });
  userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'A Long Sitting',
    sourceSurface: 'imessage',
  });
  storylineId = storyline.id;
  await storylines.markStatus(userId, storylineId, 'ready');

  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  const maya = await persons.createPerson(userId, { name: 'Maya' });
  const a = await storylines.castCharacter(userId, storylineId, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storylineId, maya.id);
  await storylines.relateCharacters(userId, storylineId, a.id, b.id, { closeness: 'was close' });
  await timeline.appendEvent(userId, storylineId, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in three weeks.',
    participantCharacterIds: [a.id, b.id],
    engagementScore: 5,
  });

  fake = createFakeGenerator();
  registerFixtures(fake);
});

describe('the balance', () => {
  it('starts full, with nothing regenerating', async () => {
    expect(await energyFor(userId)).toStrictEqual({
      remaining: TURN_ENERGY_PER_DAY,
      limit: TURN_ENERGY_PER_DAY,
      resetsAt: null,
    });
  });

  it('falls by one for each turn generated', async () => {
    const session = await sessions.startSession(userId, storylineId);
    await playOneTurn(session.id);
    await playOneTurn(session.id);

    expect((await energyFor(userId)).remaining).toBe(TURN_ENERGY_PER_DAY - 2);
  });

  /**
   * The sliding window, which is the whole design: a point returns 24 hours
   * after it was spent rather than at a reset. A turn one second past the window
   * is gone; one a minute inside it still counts.
   */
  it('returns a point once its turn ages out of the window', async () => {
    const session = await sessions.startSession(userId, storylineId);
    await playOneTurn(session.id);
    expect((await energyFor(userId)).remaining).toBe(TURN_ENERGY_PER_DAY - 1);

    await ageAllTurnsBy(ENERGY_WINDOW_MS - 60_000);
    expect((await energyFor(userId)).remaining).toBe(TURN_ENERGY_PER_DAY - 1);

    await ageAllTurnsBy(120_000);
    expect(await energyFor(userId)).toMatchObject({
      remaining: TURN_ENERGY_PER_DAY,
      resetsAt: null,
    });
  });

  it('reports when the next point comes back', async () => {
    const session = await sessions.startSession(userId, storylineId);
    await playOneTurn(session.id);

    const { resetsAt } = await energyFor(userId);
    const [row] = await db
      .select({ createdAt: storyTurns.createdAt })
      .from(storyTurns)
      .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
      .where(eq(storylineSessions.userId, userId));

    expect(resetsAt!.getTime()).toBe(row.createdAt.getTime() + ENERGY_WINDOW_MS);
  });

  // Energy is per account. Another reader playing must not cost this one a thing.
  it('counts only this reader turns', async () => {
    const [other] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_other`, email: 'other@energy.local' })
      .returning({ id: users.id });

    const session = await sessions.startSession(userId, storylineId);
    await playOneTurn(session.id);

    expect((await energyFor(other.id)).remaining).toBe(TURN_ENERGY_PER_DAY);

    await db.delete(users).where(eq(users.id, other.id));
  });
});

describe('running out', () => {
  /** Burns the whole allowance by backdating nothing — each turn is a real row. */
  async function spendEverything() {
    const session = await sessions.startSession(userId, storylineId);
    for (let i = 0; i < TURN_ENERGY_PER_DAY; i++) await playOneTurn(session.id);
    return session;
  }

  it('refuses the next turn with a retryable rate limit', async () => {
    const session = await spendEverything();

    const error = await advanceSession(userId, session.id, { generator: fake }).catch((e) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBeGreaterThan(0);
    expect(error.statusCode).toBe(429);
  });

  /**
   * The refusal has to happen before the model call, or the limit costs money
   * every time it fires — which is the opposite of what it is for.
   */
  it('spends nothing when it refuses', async () => {
    const session = await spendEverything();
    const before = fake.calls.length;

    await advanceSession(userId, session.id, { generator: fake }).catch(() => undefined);

    expect(fake.calls.length).toBe(before);
  });

  /**
   * Being out of energy must not hide the decision already in front of the
   * reader. The open turn is returned by get-or-create, which sits before the
   * check and costs nothing.
   */
  it('still returns an open turn the reader has not answered', async () => {
    const session = await sessions.startSession(userId, storylineId);
    for (let i = 0; i < TURN_ENERGY_PER_DAY - 1; i++) await playOneTurn(session.id);

    // The last point buys a turn, and this one is left unanswered.
    const open = await advanceSession(userId, session.id, { generator: fake });
    expect((await energyFor(userId)).remaining).toBe(0);

    const again = await advanceSession(userId, session.id, { generator: fake });
    expect(again.id).toBe(open.id);
  });

  /**
   * Consequences are owed work from a turn already paid for. Settling one costs
   * a model call, so discovering the reader is out of energy afterwards would
   * spend money and then refuse them.
   */
  it('does not settle an owed consequence it is about to refuse', async () => {
    const session = await sessions.startSession(userId, storylineId);
    for (let i = 0; i < TURN_ENERGY_PER_DAY; i++) await playOneTurn(session.id);

    // The last turn is answered with consequences outstanding.
    const owed = await db
      .select({ id: storyTurns.id })
      .from(storyTurns)
      .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
      .where(eq(storylineSessions.userId, userId));
    expect(owed.length).toBe(TURN_ENERGY_PER_DAY);

    const before = fake.calls.length;
    await advanceSession(userId, session.id, { generator: fake }).catch(() => undefined);

    expect(fake.calls.length).toBe(before);
  });

  /**
   * `generateTurn` is exported and called directly — by the dev lab's server
   * actions and by the scripts — so the check inside it is the authority, not
   * the one in `advanceSession`. Without this test that deeper guard can be
   * deleted and every test still passes, because they all go through
   * `advanceSession`.
   */
  it('refuses a direct generateTurn too, not just the loop', async () => {
    const session = await spendEverything();

    await expect(generateTurn(userId, session.id, { generator: fake })).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it('lets the reader play again once a point comes back', async () => {
    const session = await spendEverything();
    await expect(advanceSession(userId, session.id, { generator: fake })).rejects.toBeInstanceOf(
      RateLimitError
    );

    await ageAllTurnsBy(ENERGY_WINDOW_MS + 1000);

    await expect(advanceSession(userId, session.id, { generator: fake })).resolves.toBeTruthy();
  });

  /**
   * Derived rather than counted: a generation that throws writes no turn, so
   * nothing was spent. An incrementing counter would need a refund path and
   * would get this case wrong.
   */
  it('charges nothing for a generation that failed', async () => {
    const session = await sessions.startSession(userId, storylineId);
    const before = (await energyFor(userId)).remaining;

    const broken = createFakeGenerator();
    registerFixtures(broken);
    const { turnPrompt } = await import('@/lib/ai/prompts/turn.prompt');
    broken.register(turnPrompt, () => {
      throw new Error('the model fell over');
    });

    await expect(advanceSession(userId, session.id, { generator: broken })).rejects.toThrow();

    expect((await energyFor(userId)).remaining).toBe(before);
  });
});
