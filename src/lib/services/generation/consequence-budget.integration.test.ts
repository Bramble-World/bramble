import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '@/index';
import { storyTurns, users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { consequencePrompt } from '@/lib/ai/prompts/consequence.prompt';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import * as sessionReader from '../sessions/sessions.reader';
import { advanceSession, commitChoice, CONSEQUENCE_ATTEMPT_BUDGET } from './turns.service';

/**
 * The escape from the only unrecoverable state the loop had.
 *
 * `consequences_generated_at` could say "done" and "owed" and nothing else, so a
 * turn whose consequences failed *reproducibly* stayed owed forever:
 * `advanceSession` settles before it generates, the settle threw every time, and
 * `generateTurn` was never reached. The session could not produce another beat
 * and no client request could repair it.
 *
 * The failing generator here is not a contrivance. The consequence prompt is a
 * pure function of stored state — this turn's narrative, the chosen and rejected
 * labels, the whole timeline — so output the schema rejects, or a context that
 * outruns the deadline, reproduces exactly on every retry.
 */
const CLERK = 'user_consequence_budget';
let userId: string;
let storylineId: string;
let healthy: FakeGenerator;
let broken: FakeGenerator;

beforeAll(async () => {
  healthy = createFakeGenerator();
  registerFixtures(healthy);

  broken = createFakeGenerator();
  registerFixtures(broken);
  broken.register(consequencePrompt, () => {
    throw new Error('the model returned no usable output');
  });
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'budget@consequence.local' })
    .returning({ id: users.id });
  userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'A Session That Can Still Move',
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
  });
});

/** Answers the current turn, leaving its consequences owed. */
async function answerOneTurn(sessionId: string): Promise<string> {
  const turn = await advanceSession(userId, sessionId, { generator: healthy });
  await commitChoice(userId, turn.id, turn.choices[0].id);
  return turn.id;
}

const turnRow = async (turnId: string) => {
  const [row] = await db.select().from(storyTurns).where(eq(storyTurns.id, turnId)).limit(1);
  return row;
};

describe('the consequence attempt budget', () => {
  it('counts an attempt even though the work it counts rolled back', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    await expect(advanceSession(userId, sessionId, { generator: broken })).rejects.toThrow();

    // The whole point of writing this outside the transaction. Inside it, the
    // failure would take the count with it and the budget could never run out.
    expect(await sessionReader.consequenceAttempts(db, turnId)).toBe(1);
  });

  it('keeps failing the call while there is budget left', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    for (let attempt = 1; attempt < CONSEQUENCE_ATTEMPT_BUDGET; attempt++) {
      await expect(advanceSession(userId, sessionId, { generator: broken })).rejects.toThrow();
      expect((await turnRow(turnId)).consequencesAbandonedAt).toBeNull();
    }

    // Still owed, still retryable — a transient outage must not cost a beat.
    const owed = await sessionReader.findTurnsOwedConsequences(db, sessionId);
    expect(owed.map((t) => t.id)).toStrictEqual([turnId]);
  });

  /**
   * The fix, in one assertion: the call that exhausts the budget is the one that
   * returns a turn, rather than a fifth identical error.
   */
  it('gives up once the budget is gone, and returns a playable turn in the same call', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    for (let attempt = 1; attempt < CONSEQUENCE_ATTEMPT_BUDGET; attempt++) {
      await expect(advanceSession(userId, sessionId, { generator: broken })).rejects.toThrow();
    }

    const next = await advanceSession(userId, sessionId, { generator: broken });

    expect(next.id).not.toBe(turnId);
    expect(next.choices.length).toBeGreaterThanOrEqual(2);
    expect((await turnRow(turnId)).consequencesAbandonedAt).not.toBeNull();
  });

  // Abandonment is a stamp, not a deletion: the gap in canon is visible rather
  // than inferred from an absence.
  it('leaves the abandoned turn unresolved, never falsely marked done', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    for (let attempt = 0; attempt < CONSEQUENCE_ATTEMPT_BUDGET; attempt++) {
      await advanceSession(userId, sessionId, { generator: broken }).catch(() => {});
    }

    const row = await turnRow(turnId);
    expect(row.consequencesAbandonedAt).not.toBeNull();
    expect(row.consequencesGeneratedAt).toBeNull();
    expect(row.consequenceAttempts).toBe(CONSEQUENCE_ATTEMPT_BUDGET);
  });

  it('never asks for an abandoned turn again', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    for (let attempt = 0; attempt < CONSEQUENCE_ATTEMPT_BUDGET; attempt++) {
      await advanceSession(userId, sessionId, { generator: broken }).catch(() => {});
    }

    expect(await sessionReader.findTurnsOwedConsequences(db, sessionId)).toStrictEqual([]);
    // And the count stops climbing, which is what proves it is not being retried
    // silently on every request from here on.
    await advanceSession(userId, sessionId, { generator: broken }).catch(() => {});
    expect(await sessionReader.consequenceAttempts(db, turnId)).toBe(CONSEQUENCE_ATTEMPT_BUDGET);
  });

  /**
   * The budget must not punish a session for surviving a blip. A failure
   * followed by a success leaves nothing abandoned and no gap in canon.
   */
  it('recovers with the budget intact when the next attempt succeeds', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    await expect(advanceSession(userId, sessionId, { generator: broken })).rejects.toThrow();
    const next = await advanceSession(userId, sessionId, { generator: healthy });

    const row = await turnRow(turnId);
    expect(next.id).not.toBe(turnId);
    expect(row.consequencesGeneratedAt).not.toBeNull();
    expect(row.consequencesAbandonedAt).toBeNull();
  });

  // A turn abandoned once must not poison the session: the reader keeps playing,
  // and later decisions resolve normally.
  it('leaves the rest of the session playable', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const abandoned = await answerOneTurn(sessionId);

    for (let attempt = 0; attempt < CONSEQUENCE_ATTEMPT_BUDGET; attempt++) {
      await advanceSession(userId, sessionId, { generator: broken }).catch(() => {});
    }

    const recovered = await answerOneTurn(sessionId);
    const third = await advanceSession(userId, sessionId, { generator: healthy });

    expect(third.id).not.toBe(recovered);
    expect((await turnRow(recovered)).consequencesGeneratedAt).not.toBeNull();
    expect((await turnRow(abandoned)).consequencesGeneratedAt).toBeNull();
  });

  /**
   * A later success clears the stamp rather than leaving both set. "Abandoned"
   * describes a current state; `consequence_attempts` is what keeps the history.
   */
  it('clears abandonment when a direct retry finally succeeds', async () => {
    const sessionId = (await sessions.startSession(userId, storylineId)).id;
    const turnId = await answerOneTurn(sessionId);

    for (let attempt = 0; attempt < CONSEQUENCE_ATTEMPT_BUDGET; attempt++) {
      await advanceSession(userId, sessionId, { generator: broken }).catch(() => {});
    }
    expect((await turnRow(turnId)).consequencesAbandonedAt).not.toBeNull();

    const { generateConsequences } = await import('./turns.service');
    await generateConsequences(userId, turnId, { generator: healthy });

    const row = await turnRow(turnId);
    expect(row.consequencesGeneratedAt).not.toBeNull();
    expect(row.consequencesAbandonedAt).toBeNull();
  });
});
