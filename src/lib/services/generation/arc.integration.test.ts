import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { arcPrompt } from '@/lib/ai/prompts/arc.prompt';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as storylineReader from '../storylines/storylines.reader';
import * as storylineWriter from '../storylines/storylines.writer';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import { summarizeArc, sweepIdleSessions } from './arc.service';

const CLERK = 'user_arc_owner';
let userId: string;
let storylineId: string;
let title: string;
let fake: FakeGenerator;

/** Arc calls for this test's storyline, ignoring everything else the sweep found. */
const callsForOurStoryline = () =>
  fake.calls.filter((c) => c.promptName === 'arc.summarise' && c.prompt.includes(title));

async function makeStoryline(title: string): Promise<string> {
  const storyline = await storylines.createStoryline(userId, {
    title,
    sourceSurface: 'imessage',
  });
  await storylines.markStatus(userId, storyline.id, 'ready');

  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  await storylines.castCharacter(userId, storyline.id, self.id, { role: 'protagonist' });
  await timeline.appendEvent(userId, storyline.id, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in weeks.',
  });
  return storyline.id;
}

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
});

beforeEach(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@arc.local' })
    .returning({ id: users.id });
  userId = user.id;
  // Unique per run: the sweep is global by design, so a shared title would make
  // this test's storyline indistinguishable from the seeded ones in the prompts.
  title = `Arc Test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  storylineId = await makeStoryline(title);

  fake = createFakeGenerator();
  registerFixtures(fake);
});

describe('summarizeArc', () => {
  it('writes a summary when there are events and none yet', async () => {
    await expect(summarizeArc(userId, storylineId, { generator: fake })).resolves.toBe('written');

    const storyline = await storylineReader.getStoryline(userId, storylineId);
    expect(storyline!.arcSummary).not.toBeNull();
  });

  /**
   * The single most important assertion in this file.
   *
   * The summary is stamped with the newest event's createdAt as observed
   * *before* the model call — never with the time the write happens. Stamping
   * with now() would place the timestamp after any event written during the
   * call, so that event would look older than the summary that does not include
   * it, the staleness check would conclude there is nothing to do, and it would
   * keep concluding that. The summary would be permanently wrong and nothing
   * would report it.
   */
  it('does not swallow an event written while the model was thinking', async () => {
    // The fixture writes a new beat mid-call, standing in for a concurrent
    // commitChoice landing while the summary is being generated.
    fake.register(arcPrompt, () => ({ arcSummary: 'first summary' }));
    const racing = {
      run: async (spec: Parameters<FakeGenerator['run']>[0], vars: unknown) => {
        await timeline.appendEvent(userId, storylineId, {
          origin: 'extracted',
          title: 'Landed mid-call',
          description: 'Written while the model was thinking.',
        });
        return fake.run(spec as never, vars as never);
      },
    };

    await expect(summarizeArc(userId, storylineId, { generator: racing })).resolves.toBe('written');

    // The beat that landed mid-call is newer than the stamp, so the storyline is
    // still stale and a second pass must actually do the work.
    await expect(summarizeArc(userId, storylineId, { generator: fake })).resolves.toBe('written');
  });

  it('skips a storyline whose summary is already current', async () => {
    await summarizeArc(userId, storylineId, { generator: fake });
    const callsAfterFirst = fake.calls.length;

    await expect(summarizeArc(userId, storylineId, { generator: fake })).resolves.toBe(
      'already-current'
    );
    // And it skipped without paying for a generation.
    expect(fake.calls.length).toBe(callsAfterFirst);
  });

  it('recomputes once new beats arrive', async () => {
    await summarizeArc(userId, storylineId, { generator: fake });

    await timeline.appendEvent(userId, storylineId, {
      origin: 'extracted',
      title: 'Something new',
      description: 'x',
    });

    await expect(summarizeArc(userId, storylineId, { generator: fake })).resolves.toBe('written');
  });

  it('has nothing to do for a storyline with no beats', async () => {
    const empty = await storylines.createStoryline(userId, {
      title: 'Empty',
      sourceSurface: 'imessage',
    });

    await expect(summarizeArc(userId, empty.id, { generator: fake })).resolves.toBe(
      'nothing-to-summarise'
    );
    expect(fake.calls).toHaveLength(0);
  });

  // Recomputation is triggered by idleness, not held under a lock, so two sweeps
  // overlapping is ordinary. Losing means the other summary is newer.
  it('discards its result when another writer got there first', async () => {
    const racing = {
      run: async (spec: Parameters<FakeGenerator['run']>[0], vars: unknown) => {
        // Someone else summarises while this call is in flight.
        await storylineWriter.setArcSummaryIfUnchanged({
          storylineId,
          summary: 'written by someone else',
          watermark: new Date(),
          expected: null,
        });
        return fake.run(spec as never, vars as never);
      },
    };

    await expect(summarizeArc(userId, storylineId, { generator: racing })).resolves.toBe(
      'superseded'
    );

    const storyline = await storylineReader.getStoryline(userId, storylineId);
    expect(storyline!.arcSummary).toBe('written by someone else');
  });
});

/**
 * The sweep is deliberately global — it runs for every user, not for a request —
 * so these assert against this test's own storyline rather than against totals,
 * which also include whatever the seed left behind.
 */
describe('sweepIdleSessions', () => {
  it('leaves a session somebody is still playing alone', async () => {
    await sessions.startSession(userId, storylineId);

    await sweepIdleSessions(60_000, { generator: fake });

    expect(callsForOurStoryline()).toHaveLength(0);
    const storyline = await storylineReader.getStoryline(userId, storylineId);
    expect(storyline!.arcSummary).toBeNull();
  });

  it('summarises one that has gone idle', async () => {
    await sessions.startSession(userId, storylineId);

    await sweepIdleSessions(-60_000, { generator: fake });

    expect(callsForOurStoryline()).toHaveLength(1);
    const storyline = await storylineReader.getStoryline(userId, storylineId);
    expect(storyline!.arcSummary).not.toBeNull();
  });

  it('summarises a storyline once however many sessions it has', async () => {
    await sessions.startSession(userId, storylineId);
    await sessions.startSession(userId, storylineId);
    await sessions.startSession(userId, storylineId);

    await sweepIdleSessions(-60_000, { generator: fake });

    // Three sessions, one storyline, one generation.
    expect(callsForOurStoryline()).toHaveLength(1);
  });

  // A background pass over unrelated storylines: one failure must not stop the
  // rest, because the next storyline has nothing to do with it.
  it('counts failures and carries on rather than aborting', async () => {
    await sessions.startSession(userId, storylineId);
    fake.register(arcPrompt, () => {
      throw new Error('model exploded');
    });

    const swept = await sweepIdleSessions(-60_000, { generator: fake });

    expect(swept.considered).toBeGreaterThan(0);
    expect(swept.written).toBe(0);
    // Every candidate was attempted; none aborted the pass.
    expect(swept.skipped).toBe(swept.considered);
  });
});
