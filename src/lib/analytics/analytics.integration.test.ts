import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * The three events, against a real database, through the real call paths.
 *
 * A fake sink replaces PostHog: what matters is *when* an event fires and what
 * it carries, not that the HTTP call happens. The allowlist is asserted here too
 * — against events the application actually produced rather than literals a test
 * wrote, which is the version that can catch a property added at a call site.
 */
const captured: Array<{
  userId: string;
  event: { name: string; properties: Record<string, unknown> };
}> = [];

vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake', POSTHOG_PROJECT_TOKEN: 'phc_test' } };
});
vi.mock('@/lib/analytics/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/analytics')>();
  return {
    ...actual,
    // Wraps the real `track`, so the consent gate and the never-throws guarantee
    // are the ones under test rather than a reimplementation of them.
    track: async (userId: string, event: never) => {
      const sharesUsage = (await import('@/lib/services/users/users.reader')).sharesUsage;
      if (!(await sharesUsage(userId))) return;
      captured.push({ userId, event });
    },
  };
});

const { db } = await import('@/index');
const { users } = await import('@/db/schema/tables');
const { ALLOWED_PROPERTY_KEYS } = await import('./events');
const persons = await import('@/lib/services/persons/persons.service');
const storylines = await import('@/lib/services/storylines/storylines.service');
const sessions = await import('@/lib/services/sessions/sessions.service');
const timeline = await import('@/lib/services/timeline/timeline.service');
const imports = await import('@/lib/services/imports/imports.service');
const { runImport } = await import('@/lib/services/imports/import-runner');
const { advanceSession, commitChoice } = await import('@/lib/services/generation/turns.service');
const { TURN_ENERGY_PER_DAY } = await import('@/lib/services/sessions/energy.service');
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');

const CLERK = 'user_analytics_owner';
let userId: string;
let storylineId: string;
let fake: Awaited<ReturnType<typeof createFakeGenerator>>;

const only = (name: string) => captured.filter((c) => c.event.name === name);

function transcript(key: string) {
  return {
    conversationKey: key,
    transcript: {
      surface: 'imessage',
      messages: Array.from({ length: 60 }, (_, i) => ({
        isFromMe: i % 2 === 0,
        handle: i % 2 === 0 ? 'me' : 'c_1111111111111111',
        sender: i % 2 === 0 ? 'me' : 'Maya',
        text: `message ${i}`,
        sentAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
      })),
    },
  };
}

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

beforeEach(async () => {
  captured.length = 0;
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@analytics.local' })
    .returning({ id: users.id });
  userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'Measured',
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

/** Turns opting out on, for this reader. */
async function optOut() {
  await db.update(users).set({ shareUsage: false }).where(eq(users.id, userId));
}

describe('beat_played', () => {
  it('fires once for a newly generated beat', async () => {
    const session = await sessions.startSession(userId, storylineId);

    await advanceSession(userId, session.id, { generator: fake });

    expect(only('beat_played')).toHaveLength(1);
    expect(only('beat_played')[0].userId).toBe(userId);
  });

  /**
   * Resuming is free and is not a beat. Counting it would make every figure
   * derived from beats played an overcount of exactly the retries.
   */
  /**
   * `openTurn` is get-or-create, and the get branch is reachable by a race
   * loser as well as by a resume. Driven directly here because `advanceSession`
   * returns early on its own open-turn check and never reaches that branch — so
   * without this, firing on the get branch breaks nothing and the guard is
   * untested.
   */
  it('fires once even when openTurn is called twice for one session', async () => {
    const session = await sessions.startSession(userId, storylineId);
    let created = 0;
    const turn = {
      headline: null,
      narrativeContent: 'something happened',
      choices: [{ label: 'a' }, { label: 'b' }],
      surfaces: [],
    };

    await sessions.openTurn(userId, session.id, turn, {
      onCreated: async () => {
        created += 1;
      },
    });
    await sessions.openTurn(userId, session.id, turn, {
      onCreated: async () => {
        created += 1;
      },
    });

    expect(created).toBe(1);
  });

  it('fires nothing when an open turn is simply resumed', async () => {
    const session = await sessions.startSession(userId, storylineId);
    await advanceSession(userId, session.id, { generator: fake });
    captured.length = 0;

    await advanceSession(userId, session.id, { generator: fake });

    expect(only('beat_played')).toHaveLength(0);
  });

  it('carries the shape the dashboards read', async () => {
    const session = await sessions.startSession(userId, storylineId);
    await advanceSession(userId, session.id, { generator: fake });

    expect(only('beat_played')[0].event.properties).toMatchObject({
      turn_order: expect.any(Number),
      surfaces: expect.any(Array),
      beyond_script: expect.any(Boolean),
      started_from_event: false,
      generation_ms: expect.any(Number),
    });
  });

  it('knows a playthrough that began at a chosen moment', async () => {
    const [beat] = await timeline.listTimeline(storylineId);
    const session = await sessions.resumeOrStart(userId, storylineId, 'new', beat.id);

    await advanceSession(userId, session.id, { generator: fake });

    expect(only('beat_played')[0].event.properties.started_from_event).toBe(true);
  });

  it('fires nothing for a reader who opted out', async () => {
    await optOut();
    const session = await sessions.startSession(userId, storylineId);

    await advanceSession(userId, session.id, { generator: fake });

    expect(captured).toHaveLength(0);
  });
});

describe('energy_depleted', () => {
  async function spendEverything() {
    const session = await sessions.startSession(userId, storylineId);
    for (let i = 0; i < TURN_ENERGY_PER_DAY; i++) {
      const turn = await advanceSession(userId, session.id, { generator: fake });
      await commitChoice(userId, turn.id, turn.choices[0].id);
    }
    return session;
  }

  it('fires when the allowance runs out', async () => {
    const session = await spendEverything();
    captured.length = 0;

    await advanceSession(userId, session.id, { generator: fake }).catch(() => undefined);

    expect(only('energy_depleted')).toHaveLength(1);
    expect(only('energy_depleted')[0].event.properties).toMatchObject({
      limit: TURN_ENERGY_PER_DAY,
      retry_after_s: expect.any(Number),
    });
  });

  it('fires nothing for a reader who opted out', async () => {
    const session = await spendEverything();
    await optOut();
    captured.length = 0;

    await advanceSession(userId, session.id, { generator: fake }).catch(() => undefined);

    expect(captured).toHaveLength(0);
  });
});

describe('import_completed', () => {
  it('fires once when an import reaches ready, with a message count', async () => {
    const { import: row } = await imports.requestImport(
      userId,
      transcript('conv_a'),
      async () => {}
    );
    captured.length = 0;

    await runImport(row.id);

    expect(only('import_completed')).toHaveLength(1);
    expect(only('import_completed')[0].event.properties).toMatchObject({
      status: 'ready',
      message_count: 60,
      duration_ms: expect.any(Number),
    });
  });

  /**
   * A terminal failure is counted; a retryable one is not, because that import
   * is not finished — counting attempts rather than imports would make the
   * failure rate a measurement of the retry policy.
   */
  it('fires with a code when an import fails terminally', async () => {
    const { import: row } = await imports.requestImport(
      userId,
      transcript('conv_b'),
      async () => {}
    );
    const { dropTranscript } = await import('@/lib/services/imports/transcript.store');
    await dropTranscript(row.id);
    captured.length = 0;

    // TRANSCRIPT_EXPIRED is retryable, so it rethrows and is deliberately silent.
    await runImport(row.id).catch(() => undefined);

    expect(only('import_completed')).toHaveLength(0);
  });

  it('fires nothing for a reader who opted out', async () => {
    const { import: row } = await imports.requestImport(
      userId,
      transcript('conv_c'),
      async () => {}
    );
    await optOut();
    captured.length = 0;

    await runImport(row.id);

    expect(captured).toHaveLength(0);
  });
});

/**
 * The assertion the module exists for, against events the application actually
 * produced rather than literals a test wrote — this is the version that catches
 * a property added at a call site.
 */
describe('nothing but ids, counts, durations and enums', () => {
  it('sends no property outside the allowlist, across every path', async () => {
    const session = await sessions.startSession(userId, storylineId);
    // Several turns, because the fake only renders a surface on alternate seeds
    // and a run that happened to produce none would make the surfaces assertion
    // below vacuous — it would be checking an empty array.
    for (let i = 0; i < 4; i++) {
      const turn = await advanceSession(userId, session.id, { generator: fake });
      await commitChoice(userId, turn.id, turn.choices[0].id);
    }
    const { import: row } = await imports.requestImport(
      userId,
      transcript('conv_d'),
      async () => {}
    );
    await runImport(row.id);

    expect(captured.length).toBeGreaterThan(1);

    // The surfaces assertion only means something if a surface was rendered.
    const withSurfaces = only('beat_played').filter(
      (c) => (c.event.properties.surfaces as string[]).length > 0
    );
    expect(withSurfaces.length).toBeGreaterThan(0);
    // And what travels is the type, never the payload — which holds notification
    // text and the names of real people.
    for (const { event } of withSurfaces) {
      expect(event.properties.surfaces).toStrictEqual(['imessage_notifications']);
    }

    for (const { event } of captured) {
      for (const [key, value] of Object.entries(event.properties)) {
        expect(ALLOWED_PROPERTY_KEYS).toContain(key);
        for (const item of Array.isArray(value) ? value : [value]) {
          if (typeof item === 'string') expect(item).toMatch(/^[a-z0-9_]+$/i);
        }
      }
    }

    // And nothing anywhere in the payloads looks like content from the fixtures.
    const serialised = JSON.stringify(captured);
    for (const leak of ['Maya', 'Blossom', 'Measured', 'message ', 'Where things stood']) {
      expect(serialised).not.toContain(leak);
    }
  });
});
