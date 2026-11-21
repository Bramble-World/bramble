import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { storylines as storylinesTable, storylineSessions, users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { endingPrompt } from '@/lib/ai/prompts/ending.prompt';
import { GenerationFailedError, GenerationUnusableError } from '@/lib/utils/errors';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import { advanceSession, commitChoice } from '../generation/turns.service';
import { ENDING_LEASE_MS, ENDING_MAX_ATTEMPTS, endingRecord, writeEnding } from './ending.service';
import { ENDING_SWEEP_GRACE_MS, endingsOwed, sweepEndings } from './ending.sweep';

/**
 * Writing the ending page, against a real database and the fake generator:
 * the attempt lease that keeps every-2 s reads on two pods to one model call,
 * the cap, the retry inside an attempt, the key-choice fallback, and the sweep.
 */
const CLERK = 'user_endings_owner';
let userId: string;
let storylineId: string;
let fake: FakeGenerator;

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@endings.local' })
    .returning({ id: users.id });
  userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'The Unsent Apology',
    sourceSurface: 'imessage',
    tone: 'wistful',
  });
  storylineId = storyline.id;
  await storylines.markStatus(userId, storylineId, 'ready');
  // The closing window opens at beat 2, where the fake ends as soon as it may.
  await db
    .update(storylinesTable)
    .set({ targetBeats: 6 })
    .where(eq(storylinesTable.id, storylineId));

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
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
});

beforeEach(async () => {
  fake = createFakeGenerator();
  registerFixtures(fake);
  await db.delete(storylineSessions).where(eq(storylineSessions.userId, userId));
});

/** A story played to its ending (beat 2), with no ending page written yet. */
async function endedSession() {
  const session = await sessions.startSession(userId, storylineId);
  const first = await advanceSession(userId, session.id, { generator: fake });
  await commitChoice(userId, first.id, first.choices[0].id);
  const last = await advanceSession(userId, session.id, { generator: fake });
  expect(last.isEnding).toBe(true);
  return { session, first };
}

const endingCalls = () => fake.calls.filter((c) => c.promptName === 'ending.summarise').length;

/** Moves the session's last attempt (and, optionally, its ending) into the past. */
async function backdate(sessionId: string, { attemptMs = 0, endedMs = 0 } = {}) {
  const now = Date.now();
  await db
    .update(storylineSessions)
    .set({
      ...(attemptMs ? { endingAttemptedAt: new Date(now - attemptMs) } : {}),
      ...(endedMs ? { endedAt: new Date(now - endedMs) } : {}),
    })
    .where(eq(storylineSessions.id, sessionId));
}

const failingOnce = () => {
  let calls = 0;
  fake.register(endingPrompt, () => {
    calls += 1;
    throw Object.assign(new GenerationFailedError('Generation failed for "ending.summarise"'), {
      cause: { name: 'AI_APICallError', statusCode: calls === 1 ? 503 : 400 },
    });
  });
};

describe('the attempt lease', () => {
  it('lets two writers at once make one model call between them', async () => {
    const { session } = await endedSession();

    const [a, b] = await Promise.all([
      writeEnding(userId, session.id, { generator: fake, trigger: 'read' }),
      writeEnding(userId, session.id, { generator: fake, trigger: 'read' }),
    ]);

    expect(endingCalls()).toBe(1);
    expect([a, b].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect((await endingRecord(session.id)).attempts).toBe(1);
  });

  it('holds off a retry until the lease is up, then tries again', async () => {
    const { session } = await endedSession();
    fake.register(endingPrompt, () => {
      throw new GenerationUnusableError('The model returned no usable output for "ending"');
    });

    await expect(writeEnding(userId, session.id, { generator: fake })).rejects.toBeInstanceOf(
      GenerationUnusableError
    );
    // The app reads again 2 s later: nothing starts.
    expect(await writeEnding(userId, session.id, { generator: fake })).toBeNull();
    expect(endingCalls()).toBe(1);

    registerFixtures(fake);
    await backdate(session.id, { attemptMs: ENDING_LEASE_MS + 1_000 });
    const ending = await writeEnding(userId, session.id, { generator: fake });

    expect(ending?.title).toBe('the long way home');
    expect((await endingRecord(session.id)).attempts).toBe(2);
  });

  it('stops trying at the cap', async () => {
    const { session } = await endedSession();
    await db
      .update(storylineSessions)
      .set({
        endingAttempts: ENDING_MAX_ATTEMPTS,
        endingAttemptedAt: new Date(Date.now() - ENDING_LEASE_MS * 10),
      })
      .where(eq(storylineSessions.id, session.id));

    expect(await writeEnding(userId, session.id, { generator: fake })).toBeNull();
    expect(endingCalls()).toBe(0);
  });
});

describe('a transient failure', () => {
  it('is tried once more inside the attempt', async () => {
    const { session } = await endedSession();
    let calls = 0;
    fake.register(endingPrompt, () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new GenerationFailedError('Generation failed for "ending.summarise"'), {
          cause: { name: 'AI_APICallError', statusCode: 503 },
        });
      }
      return {
        title: 'the long way home',
        summary: 'you went. it was worth it.',
        keyChoices: [{ beat: 1, label: 'you texted back' }],
        storyNights: 1,
      };
    });

    const ending = await writeEnding(userId, session.id, { generator: fake });

    expect(calls).toBe(2);
    expect(ending?.title).toBe('the long way home');
    expect((await endingRecord(session.id)).attempts).toBe(1);
  });

  it('is not tried again after a 4xx', async () => {
    const { session } = await endedSession();
    let calls = 0;
    fake.register(endingPrompt, () => {
      calls += 1;
      throw Object.assign(new GenerationFailedError('Generation failed for "ending.summarise"'), {
        cause: { name: 'AI_APICallError', statusCode: 400 },
      });
    });

    await expect(writeEnding(userId, session.id, { generator: fake })).rejects.toBeInstanceOf(
      GenerationFailedError
    );
    expect(calls).toBe(1);
  });

  it('gives up for the attempt when the retry fails too', async () => {
    const { session } = await endedSession();
    failingOnce();

    await expect(writeEnding(userId, session.id, { generator: fake })).rejects.toBeInstanceOf(
      GenerationFailedError
    );
    expect((await endingRecord(session.id)).ending).toBeNull();
  });
});

describe('key choices', () => {
  it('fall back to the reader’s own choice when the model names none they made', async () => {
    const { session, first } = await endedSession();
    fake.register(endingPrompt, () => ({
      title: 'the long way home',
      summary: 'you went. it was worth it.',
      // Beat 2 is the ending, which has no choice.
      keyChoices: [{ beat: 2, label: 'you said goodbye' }],
      storyNights: 1,
    }));

    const ending = await writeEnding(userId, session.id, { generator: fake });

    const picked = first.choices[0].label;
    expect(ending?.keyChoices).toEqual([
      { turnId: first.id, label: picked.charAt(0).toLowerCase() + picked.slice(1) },
    ]);
  });
});

describe('the ending sweep', () => {
  it('writes an ending owed for longer than the grace, and leaves a recent one', async () => {
    const owed = await endedSession();
    const recent = await endedSession();
    // The ending turn's write was cut short: one attempt, long ago, no ending.
    await db
      .update(storylineSessions)
      .set({ endingAttempts: 1 })
      .where(eq(storylineSessions.id, owed.session.id));
    await backdate(owed.session.id, {
      attemptMs: ENDING_LEASE_MS + 1_000,
      endedMs: ENDING_SWEEP_GRACE_MS + 1_000,
    });

    const ids = (await endingsOwed()).map((row) => row.sessionId);
    expect(ids).toContain(owed.session.id);
    expect(ids).not.toContain(recent.session.id);

    const result = await sweepEndings({ generator: fake });

    expect(result.written).toBeGreaterThanOrEqual(1);
    expect((await endingRecord(owed.session.id)).ending?.title).toBe('the long way home');
    expect((await endingRecord(recent.session.id)).ending).toBeNull();
  });

  it('passes over a session at the cap, or one being written now', async () => {
    const capped = await endedSession();
    const busy = await endedSession();
    await db
      .update(storylineSessions)
      .set({ endingAttempts: ENDING_MAX_ATTEMPTS })
      .where(eq(storylineSessions.id, capped.session.id));
    await db
      .update(storylineSessions)
      .set({ endingAttempts: 1, endingAttemptedAt: new Date() })
      .where(eq(storylineSessions.id, busy.session.id));
    for (const { session } of [capped, busy]) {
      await backdate(session.id, { endedMs: ENDING_SWEEP_GRACE_MS + 1_000 });
    }

    const ids = (await endingsOwed()).map((row) => row.sessionId);

    expect(ids).not.toContain(capped.session.id);
    expect(ids).not.toContain(busy.session.id);
  });
});
