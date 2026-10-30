import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';

/**
 * Guests, end to end: created, named into a story, three beats, the wall, and
 * signed up — into a new account and into one that already existed.
 *
 * Against a real database, a real Redis and the fake generator, through the
 * route handlers. Only two things are stubbed:
 *
 * - **Clerk.** `requireClerkUserId` and `clerkIdentity` stand in for a signed-in
 *   session on the claim route. Guest tokens are *not* stubbed: they are signed
 *   and verified for real, through the real `requireCurrentUser`, which is the
 *   dispatch this PR adds and the thing most worth exercising.
 * - **The analytics sink**, replaced by a list, so the test can assert when each
 *   event fires and what it carries. The consent check is still the real one.
 *
 * Attestation is off here (NODE_ENV is test), except in the block that turns it
 * on — where the verifier is mocked, because no real iPhone has attested a key
 * for this app in a test run. The verifier itself is tested against real
 * attestations in app-attest.test.ts.
 */
const captured: Array<{ userId: string; event: { name: string; properties: unknown } }> = [];
const aliases: Array<{ userId: string; previousId: string }> = [];

vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  // A plain object, so a test can flip GUEST_ATTESTATION and restore it.
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});
vi.mock('@/lib/services/auth/auth.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/auth.service')>();
  return { ...actual, requireClerkUserId: vi.fn(), clerkIdentity: vi.fn() };
});
vi.mock('@/lib/services/guests/app-attest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/guests/app-attest')>();
  return { ...actual, verifyAttestation: vi.fn() };
});
vi.mock('@/lib/analytics/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/analytics')>();
  const reader = () => import('@/lib/services/users/users.reader');
  return {
    ...actual,
    track: async (userId: string, event: never) => {
      if (!(await (await reader()).sharesUsage(userId))) return;
      captured.push({ userId, event });
    },
    trackAlias: async (userId: string, previousId: string) => {
      if (!(await (await reader()).sharesUsage(userId))) return;
      aliases.push({ userId, previousId });
    },
  };
});

const { env } = await import('@/env');
const { db } = await import('@/index');
const tables = await import('@/db/schema/tables');
const { users, persons, personRelationships, storylines, characters, motifs, motifParticipants } =
  tables;
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const appAttest = vi.mocked(await import('@/lib/services/guests/app-attest'));
const { redis } = await import('@/lib/redis/client');
const { claimGuest, USER_OWNED_TABLES } = await import('@/lib/services/guests/guests.claim');
const { createGuest, sweepExpiredGuests } = await import('@/lib/services/guests/guests.service');
const { createGuestStory } = await import('@/lib/services/onboarding/onboarding.service');
const { advanceSession } = await import('@/lib/services/generation/turns.service');
const sessions = await import('@/lib/services/sessions/sessions.service');
const { GUESTS_PER_IP_PER_HOUR } = await import('@/lib/services/guests/ip-limit');

const guestsRoute = await import('@/app/api/v1/guests/route');
const challengeRoute = await import('@/app/api/v1/guests/challenge/route');
const claimRoute = await import('@/app/api/v1/guests/claim/route');
const openingRoute = await import('@/app/api/v1/onboarding/opening/route');
const storyRoute = await import('@/app/api/v1/onboarding/story/route');
const meRoute = await import('@/app/api/me/route');
const preferencesRoute = await import('@/app/api/v1/me/preferences/route');
const sessionRoute = await import('@/app/api/v1/sessions/[sessionId]/route');
const turnRoute = await import('@/app/api/v1/sessions/[sessionId]/turn/route');
const answerRoute = await import('@/app/api/v1/sessions/[sessionId]/answer/route');
const importsRoute = await import('@/app/api/v1/imports/route');
const worldRoute = await import('@/app/api/v1/world/route');

const CLERK_NEW = 'user_guest_claim_new';
const CLERK_EXISTING = 'user_guest_claim_existing';
const CLERK_NO_SELF = 'user_guest_claim_no_self';
const CLERK_RACE = 'user_guest_claim_race';
const CLERK_BYSTANDER = 'user_guest_sweep_bystander';
const CLERKS = [CLERK_NEW, CLERK_EXISTING, CLERK_NO_SELF, CLERK_RACE, CLERK_BYSTANDER];

/** Every guest a test made, so they can all be removed whatever happened. */
const guestIds: string[] = [];

/** A fresh address per request, so the hourly limit never carries between runs. */
let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}, 10.0.0.1`;

const BASE = 'http://api.test';
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Request {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function newGuest(ip = freshIp()): Promise<{ token: string; id: string; expiresAt: string }> {
  const res = await guestsRoute.POST(
    request('POST', '/api/v1/guests', { headers: { 'x-forwarded-for': ip } })
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  guestIds.push(body.user.id);
  return { token: body.token, id: body.user.id, expiresAt: body.expiresAt };
}

async function nameStory(token: string, body: Record<string, unknown>) {
  return storyRoute.POST(
    request('POST', '/api/v1/onboarding/story', {
      token,
      body: { openingId: 'are_you_up', relationship: 'ex', name: 'Jordan', ...body },
    }),
    ctx({})
  );
}

type TurnBody = {
  id: string;
  headline: string | null;
  narrative: string;
  choices: { id: string; label: string }[];
  surfaces: Array<{
    type: string;
    clockTime: string | null;
    dateLabel: string | null;
    notifications: { sender: { id: string; name: string; isSelf: boolean }; text: string }[];
  }>;
};

async function answer(token: string, sessionId: string, turn: TurnBody) {
  const res = await answerRoute.POST(
    request('POST', `/api/v1/sessions/${sessionId}/answer`, {
      token,
      body: { turnId: turn.id, choiceId: turn.choices[0].id },
    }),
    ctx({ sessionId })
  );
  expect(res.status).toBe(200);
}

async function nextTurn(token: string, sessionId: string) {
  return turnRoute.POST(
    request('POST', `/api/v1/sessions/${sessionId}/turn`, { token }),
    ctx({ sessionId })
  );
}

/** A guest with a story, played to the wall: three beats, all answered. */
async function guestAtTheWall() {
  const guest = await newGuest();
  const story = (await (await nameStory(guest.token, { pronouns: 'she' })).json()).story;
  await answer(guest.token, story.sessionId, story.turn);
  for (let n = 2; n <= 3; n++) {
    const turn = (await (await nextTurn(guest.token, story.sessionId)).json()).turn;
    await answer(guest.token, story.sessionId, turn);
  }
  return { guest, story };
}

async function makeAccount(clerkId: string, withSelf: boolean): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ clerkId, email: `${clerkId}@guests.local` })
    .returning({ id: users.id });
  if (withSelf) {
    await db.insert(persons).values({ userId: row.id, name: 'Blossom', isSelf: true });
  }
  return row.id;
}

/** Signs in as `clerkId` for the claim route. */
function signInAs(clerkId: string) {
  auth.requireClerkUserId.mockResolvedValue(clerkId);
  auth.clerkIdentity.mockResolvedValue({ email: `${clerkId}@Guests.Local`, verified: true });
}

async function claim(guestToken: string, body?: unknown) {
  return claimRoute.POST(
    request('POST', '/api/v1/guests/claim', {
      token: 'clerk-session-token',
      headers: { 'x-bramble-guest': guestToken },
      body,
    })
  );
}

const only = (name: string) => captured.filter((c) => c.event.name === name);

async function cleanUp() {
  await db.delete(users).where(inArray(users.clerkId, CLERKS));
  if (guestIds.length) await db.delete(users).where(inArray(users.id, guestIds));
}

beforeEach(async () => {
  vi.clearAllMocks();
  captured.length = 0;
  aliases.length = 0;
  (env as { GUEST_ATTESTATION?: string }).GUEST_ATTESTATION = undefined;
  await cleanUp();
});

afterAll(async () => {
  await cleanUp();
  const keys = await redis('test cleanup').keys('ratelimit:guest*');
  if (keys.length) await redis('test cleanup').del(...keys);
});

describe('POST /api/v1/guests', () => {
  it('creates a guest, with a self person and a token that lasts seven days', async () => {
    const before = Date.now();
    const guest = await newGuest();

    const expires = new Date(guest.expiresAt).getTime();
    expect(expires - before).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(expires - before).toBeLessThan(7 * 24 * 3600 * 1000 + 60_000);

    const [row] = await db.select().from(users).where(eq(users.id, guest.id));
    expect(row).toMatchObject({
      isGuest: true,
      clerkId: null,
      email: null,
      appAttestKeyId: null,
    });
    expect(row.guestExpiresAt?.toISOString()).toBe(guest.expiresAt);

    const selves = await db
      .select()
      .from(persons)
      .where(and(eq(persons.userId, guest.id), eq(persons.isSelf, true)));
    expect(selves).toHaveLength(1);
  });

  it('works with GET /api/me, which answers with no email and isGuest', async () => {
    const guest = await newGuest();
    const res = await meRoute.GET(request('GET', '/api/me', { token: guest.token }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: guest.id,
      email: null,
      shareUsage: true,
      isGuest: true,
    });
  });

  it('lets a guest turn usage data off', async () => {
    const guest = await newGuest();
    const res = await preferencesRoute.PUT(
      request('PUT', '/api/v1/me/preferences', { token: guest.token, body: { shareUsage: false } }),
      ctx({})
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ shareUsage: false });

    // And the server then sends nothing for them.
    await openingRoute.GET(
      request('GET', '/api/v1/onboarding/opening', { token: guest.token }),
      ctx({})
    );
    expect(only('onboarding_opened')).toHaveLength(0);
  });

  it(`limits one address to ${GUESTS_PER_IP_PER_HOUR} guests an hour`, async () => {
    const ip = `203.0.113.${Date.now() % 250}-${Math.random()}`;
    for (let i = 0; i < GUESTS_PER_IP_PER_HOUR; i++) await newGuest(ip);

    const res = await guestsRoute.POST(
      request('POST', '/api/v1/guests', { headers: { 'x-forwarded-for': `${ip}, 10.1.2.3` } })
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json()).error.code).toBe('RATE_LIMITED');

    // Another address is unaffected.
    await newGuest();
  });
});

describe('guest tokens', () => {
  it('stop working the moment the guest expires', async () => {
    const guest = await newGuest();
    await db
      .update(users)
      .set({ guestExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, guest.id));

    const res = await meRoute.GET(request('GET', '/api/me', { token: guest.token }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('stop working when the guest is deleted', async () => {
    const guest = await newGuest();
    await db.delete(users).where(eq(users.id, guest.id));
    const res = await meRoute.GET(request('GET', '/api/me', { token: guest.token }));
    expect(res.status).toBe(401);
  });

  it('cannot import', async () => {
    const guest = await newGuest();
    const res = await importsRoute.GET(
      request('GET', '/api/v1/imports', { token: guest.token }),
      ctx({})
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('SIGNUP_REQUIRED');
  });
});

describe('GET /api/v1/onboarding/opening', () => {
  it('serves the 1:47 AM opening, and counts it', async () => {
    const guest = await newGuest();
    const res = await openingRoute.GET(
      request('GET', '/api/v1/onboarding/opening', { token: guest.token }),
      ctx({})
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      opening: {
        id: 'are_you_up',
        clockTime: '1:47',
        dateLabel: 'Saturday, June 14',
        text: 'hey. are you up?',
        timeLabel: '1:47 am',
      },
    });
    expect(only('onboarding_opened')).toEqual([
      {
        userId: guest.id,
        event: { name: 'onboarding_opened', properties: { opening_id: 'are_you_up' } },
      },
    ]);
  });
});

describe('POST /api/v1/onboarding/story', () => {
  it('writes beat 1 from the script, with the name and pronouns in it', async () => {
    const guest = await newGuest();
    const res = await nameStory(guest.token, { name: '  Jordan ', pronouns: 'she' });
    expect(res.status).toBe(201);

    const { story } = await res.json();
    expect(story.storylineTitle).toBe('the night before');
    expect(story.person).toEqual({ id: expect.any(String), name: 'Jordan', isSelf: false });
    expect(story.turn.headline).toBe(
      'Jordan is getting married tomorrow. And she just texted you.'
    );
    expect(story.turn.narrative).toBe(
      "You stare at the screen until it dims, then tap it awake again. Three dots appear. Then they're gone."
    );
    expect(story.turn.choices.map((c: { label: string }) => c.label)).toEqual([
      'Text back: "i\'m up."',
      'Call Jordan right now',
      'Leave it on read and try to sleep',
    ]);
    expect(story.turn.surfaces).toEqual([
      {
        type: 'imessage_notifications',
        clockTime: '1:48',
        dateLabel: 'Saturday, June 14',
        notifications: [
          {
            sender: story.person,
            text: "i know it's late. i'm getting married tomorrow and i need to say something before i do",
          },
          { sender: story.person, text: 'hey. are you up?' },
        ],
      },
    ]);

    // What was stored: the pronouns on the person, the chip as the relationship.
    const [jordan] = await db.select().from(persons).where(eq(persons.id, story.person.id));
    expect(jordan.pronouns).toBe('she');
    const [relationship] = await db
      .select()
      .from(personRelationships)
      .where(eq(personRelationships.userId, guest.id));
    expect(relationship.relationshipType).toBe('ex');

    expect(only('person_named').map((c) => c.event.properties)).toEqual([
      { relationship: 'ex', pronouns_given: 'yes' },
    ]);
    expect(only('guest_beat_played').map((c) => c.event.properties)).toEqual([{ n: 1 }]);
    // The name never reaches analytics, in any property.
    expect(JSON.stringify(captured)).not.toContain('Jordan');
  });

  it('says "they" when pronouns are skipped', async () => {
    const guest = await newGuest();
    const { story } = await (
      await nameStory(guest.token, { name: 'Sam', relationship: 'old_friend' })
    ).json();
    expect(story.turn.headline).toBe('Sam is getting married tomorrow. And they just texted you.');
    const [sam] = await db.select().from(persons).where(eq(persons.id, story.person.id));
    expect(sam.pronouns).toBe('they');
    expect(only('person_named')[0].event.properties).toEqual({
      relationship: 'old_friend',
      pronouns_given: 'no',
    });
  });

  it('returns the story the guest already has rather than writing a second', async () => {
    const guest = await newGuest();
    const first = await (await nameStory(guest.token, {})).json();
    const again = await nameStory(guest.token, { name: 'Someone Else' });

    expect(again.status).toBe(200);
    const second = await again.json();
    expect(second.story.sessionId).toBe(first.story.sessionId);
    expect(second.story.person.name).toBe('Jordan');
    expect(second.story.turn.id).toBe(first.story.turn.id);
    expect(await db.select().from(storylines).where(eq(storylines.userId, guest.id))).toHaveLength(
      1
    );

    // Once beat 1 is answered there is no open turn to hand back.
    await answer(guest.token, first.story.sessionId, first.story.turn);
    const third = await (await nameStory(guest.token, {})).json();
    expect(third.story.turn).toBeNull();
  });

  it.each([
    ['an empty name', { name: '   ' }, 'name'],
    ['a name over 24 characters', { name: 'A'.repeat(25) }, 'name'],
    ['a name with a line break', { name: 'Jor\ndan' }, 'name'],
    ['an unknown relationship', { relationship: 'landlord' }, 'relationship'],
    ['unknown pronouns', { pronouns: 'xe' }, 'pronouns'],
  ])('refuses %s', async (_label, body, field) => {
    const guest = await newGuest();
    const res = await nameStory(guest.token, body);
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).error.fields)).toContain(field);
  });

  it('counts a 24-character name as a person would, emoji and all', async () => {
    const guest = await newGuest();
    // 24 graphemes, more than 24 UTF-16 units.
    const res = await nameStory(guest.token, { name: '👩‍👩‍👧'.repeat(2) + 'J'.repeat(22) });
    expect(res.status).toBe(201);
  });

  it('refuses an opening that does not exist', async () => {
    const guest = await newGuest();
    const res = await nameStory(guest.token, { openingId: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.fields).toEqual({ openingId: 'Unknown opening' });
  });
});

describe('a guest plays three beats, then hits the wall', () => {
  it('plays beats 2 and 3 through the ordinary loop, with no energy', async () => {
    const guest = await newGuest();
    const { story } = await (await nameStory(guest.token, { pronouns: 'he' })).json();

    const probe = await sessionRoute.GET(
      request('GET', `/api/v1/sessions/${story.sessionId}`, { token: guest.token }),
      ctx({ sessionId: story.sessionId })
    );
    const snapshot = await probe.json();
    expect(snapshot.energy).toBeNull();
    expect(snapshot.session.state).toBe('awaiting_answer');
    expect(snapshot.session.turn.id).toBe(story.turn.id);

    await answer(guest.token, story.sessionId, story.turn);

    for (const n of [2, 3]) {
      const res = await nextTurn(guest.token, story.sessionId);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.energy).toBeNull();
      expect(body.turn.choices.length).toBeGreaterThan(0);

      // Resuming the open turn is free and returns the same beat.
      const again = await (await nextTurn(guest.token, story.sessionId)).json();
      expect(again.turn.id).toBe(body.turn.id);

      await answer(guest.token, story.sessionId, body.turn);
      expect(only('guest_beat_played').at(-1)?.event.properties).toEqual({ n });
    }

    const wall = await nextTurn(guest.token, story.sessionId);
    expect(wall.status).toBe(403);
    expect((await wall.json()).error).toEqual({
      code: 'SIGNUP_REQUIRED',
      message: 'Sign up to keep playing.',
    });
    // Never an energy refusal, and no beat was written.
    expect(only('energy_depleted')).toHaveLength(0);
    expect(only('guest_beat_played').map((c) => c.event.properties)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);

    // Reading it again still works.
    const reread = await sessionRoute.GET(
      request('GET', `/api/v1/sessions/${story.sessionId}`, { token: guest.token }),
      ctx({ sessionId: story.sessionId })
    );
    expect(reread.status).toBe(200);
    expect((await reread.json()).session.history).toHaveLength(3);
  });

  it('does not get a fourth beat by starting another playthrough', async () => {
    const { guest, story } = await guestAtTheWall();
    const fresh = await sessions.startSession(guest.id, story.storylineId);
    const res = await nextTurn(guest.token, fresh.id);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('SIGNUP_REQUIRED');
  });

  it('sees no energy on the world screen either', async () => {
    const guest = await newGuest();
    await nameStory(guest.token, {});
    const res = await worldRoute.GET(
      request('GET', '/api/v1/world', { token: guest.token }),
      ctx({})
    );
    const body = await res.json();
    expect(body.energy).toBeNull();
    expect(body.events.map((e: { storylineTitle: string }) => e.storylineTitle)).toContain(
      'the night before'
    );
  });
});

describe('POST /api/v1/guests/claim', () => {
  it('needs a Clerk session', async () => {
    const guest = await newGuest();
    auth.requireClerkUserId.mockRejectedValue(
      new (await import('@/lib/utils/errors')).UnauthorizedError()
    );
    const res = await claim(guest.token);
    expect(res.status).toBe(401);
  });

  it('needs a live guest token', async () => {
    signInAs(CLERK_NEW);
    const res = await claim('not-a-token');
    expect(res.status).toBe(401);
  });

  it('turns the guest into a new account, and the story plays on to beat 4', async () => {
    const { guest, story } = await guestAtTheWall();
    signInAs(CLERK_NEW);

    const res = await claim(guest.token, { method: 'apple' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ merged: false, user: { id: guest.id } });

    const [row] = await db.select().from(users).where(eq(users.id, guest.id));
    expect(row).toMatchObject({
      clerkId: CLERK_NEW,
      email: `${CLERK_NEW}@guests.local`,
      isGuest: false,
      guestExpiresAt: null,
      appAttestKeyId: null,
    });
    expect(row.emailVerifiedAt).not.toBeNull();

    // The guest token is finished.
    const me = await meRoute.GET(request('GET', '/api/me', { token: guest.token }));
    expect(me.status).toBe(401);

    // The account is past the wall: beat 4, paid for in energy now.
    const four = await advanceSession(guest.id, story.sessionId);
    expect(four.turnOrder).toBe(4);

    expect(only('signup_completed').map((c) => c.event.properties)).toEqual([
      { merged: false, method: 'apple' },
    ]);
    expect(aliases).toEqual([]);
  });

  it('moves the story into an existing account and merges the two selves', async () => {
    const accountId = await makeAccount(CLERK_EXISTING, true);
    const [accountSelf] = await db
      .select()
      .from(persons)
      .where(and(eq(persons.userId, accountId), eq(persons.isSelf, true)));

    const { guest, story } = await guestAtTheWall();
    const [guestSelf] = await db
      .select()
      .from(persons)
      .where(and(eq(persons.userId, guest.id), eq(persons.isSelf, true)));
    // A motif the guest's self shares with Jordan, so the participant merge has
    // something to move.
    const [motif] = await db
      .insert(motifs)
      .values({ userId: guest.id, label: 'the wedding' })
      .returning({ id: motifs.id });
    await db.insert(motifParticipants).values([
      { motifId: motif.id, personId: guestSelf.id },
      { motifId: motif.id, personId: story.person.id },
    ]);

    signInAs(CLERK_EXISTING);
    const res = await claim(guest.token, { method: 'passkey' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ merged: true, user: { id: accountId } });

    // The guest is gone; nothing is left under its id.
    expect(await db.select().from(users).where(eq(users.id, guest.id))).toHaveLength(0);
    for (const table of USER_OWNED_TABLES) {
      expect(await db.select().from(table).where(eq(table.userId, guest.id))).toHaveLength(0);
    }

    // One self, the account's, cast as "you" in the guest's story.
    const selves = await db
      .select()
      .from(persons)
      .where(and(eq(persons.userId, accountId), eq(persons.isSelf, true)));
    expect(selves.map((p) => p.id)).toEqual([accountSelf.id]);
    const [protagonist] = await db
      .select()
      .from(characters)
      .where(
        and(eq(characters.storylineId, story.storylineId), eq(characters.role, 'protagonist'))
      );
    expect(protagonist.personId).toBe(accountSelf.id);

    // The relationship now joins the account's self and Jordan, sorted.
    const [relationship] = await db
      .select()
      .from(personRelationships)
      .where(eq(personRelationships.userId, accountId));
    expect([relationship.personAId, relationship.personBId]).toEqual(
      [accountSelf.id, story.person.id].sort()
    );
    expect(relationship.relationshipType).toBe('ex');

    const participants = await db
      .select()
      .from(motifParticipants)
      .where(eq(motifParticipants.motifId, motif.id));
    expect(participants.map((p) => p.personId).sort()).toEqual(
      [accountSelf.id, story.person.id].sort()
    );

    // The playthrough is the account's, and resumes where the guest left it.
    const snapshot = await sessions.sessionSnapshot(accountId, story.sessionId);
    expect(snapshot.history).toHaveLength(3);
    const four = await advanceSession(accountId, story.sessionId);
    expect(four.turnOrder).toBe(4);

    const me = await meRoute.GET(request('GET', '/api/me', { token: guest.token }));
    expect(me.status).toBe(401);

    expect(aliases).toEqual([{ userId: accountId, previousId: guest.id }]);
    expect(only('signup_completed')).toEqual([
      {
        userId: accountId,
        event: { name: 'signup_completed', properties: { merged: true, method: 'passkey' } },
      },
    ]);
  });

  it("gives an account with no self person the guest's", async () => {
    const accountId = await makeAccount(CLERK_NO_SELF, false);
    const guest = await newGuest();
    await nameStory(guest.token, {});
    const [guestSelf] = await db
      .select()
      .from(persons)
      .where(and(eq(persons.userId, guest.id), eq(persons.isSelf, true)));

    signInAs(CLERK_NO_SELF);
    const res = await claim(guest.token);
    expect((await res.json()).merged).toBe(true);

    const selves = await db
      .select()
      .from(persons)
      .where(and(eq(persons.userId, accountId), eq(persons.isSelf, true)));
    expect(selves.map((p) => p.id)).toEqual([guestSelf.id]);
    // No method reported, so none is sent.
    expect(only('signup_completed')[0].event.properties).toEqual({ merged: true });
  });

  it('merges after all when the Clerk webhook creates the account mid-claim', async () => {
    const guest = await newGuest();
    await nameStory(guest.token, {});

    let accountId = '';
    const result = await claimGuest({
      guestId: guest.id,
      clerkId: CLERK_RACE,
      // The webhook lands between "no account yet" and the write that would
      // have made the guest the account.
      fetchIdentity: async () => {
        accountId = await makeAccount(CLERK_RACE, true);
        return { email: `${CLERK_RACE}@guests.local`, verified: true };
      },
    });

    expect(result).toEqual({ merged: true, userId: accountId });
    expect(await db.select().from(users).where(eq(users.id, guest.id))).toHaveLength(0);
    expect(await db.select().from(storylines).where(eq(storylines.userId, accountId))).toHaveLength(
      1
    );
  });

  it('happens once: a second claim with the same guest token is a 401', async () => {
    const guest = await newGuest();
    signInAs(CLERK_NEW);
    expect((await claim(guest.token)).status).toBe(200);
    expect((await claim(guest.token)).status).toBe(401);
  });
});

describe('the schema and the claim agree on what a user owns', () => {
  it('re-points every table that has a user_id column', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id'
    `);
    const live = result.rows.map((r) => r.table_name).sort();
    expect(USER_OWNED_TABLES.map((t) => getTableName(t)).sort()).toEqual(live);
  });
});

describe('the guest sweep', () => {
  it('deletes expired guests and their stories, and nothing else', async () => {
    const expired = await createGuest(null);
    const live = await createGuest(null);
    guestIds.push(expired.user.id, live.user.id);
    await createGuestStory(
      expired.user.id,
      'are_you_up',
      { name: 'Jordan', relationship: 'crush', pronouns: 'they' },
      { pronounsGiven: false }
    );
    await createGuestStory(
      live.user.id,
      'are_you_up',
      { name: 'Riley', relationship: 'boss', pronouns: 'he' },
      { pronounsGiven: true }
    );
    await db
      .update(users)
      .set({ guestExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(users.id, expired.user.id));
    const bystander = await makeAccount(CLERK_BYSTANDER, true);

    const { deleted } = await sweepExpiredGuests();
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await db.select().from(users).where(eq(users.id, expired.user.id))).toHaveLength(0);
    expect(
      await db.select().from(storylines).where(eq(storylines.userId, expired.user.id))
    ).toHaveLength(0);
    expect(await db.select().from(persons).where(eq(persons.userId, expired.user.id))).toHaveLength(
      0
    );

    expect(await db.select().from(users).where(eq(users.id, live.user.id))).toHaveLength(1);
    expect(
      await db.select().from(storylines).where(eq(storylines.userId, live.user.id))
    ).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.id, bystander))).toHaveLength(1);
  });
});

describe('when attestation is required', () => {
  const ATTESTATION = { keyId: 'a2V5', attestationObject: 'b2Jq', challenge: '' };

  beforeEach(() => {
    (env as { GUEST_ATTESTATION?: string }).GUEST_ATTESTATION = 'required';
    appAttest.verifyAttestation.mockImplementation(() => {
      throw new appAttest.AttestationError('test: refused');
    });
  });

  async function challenge(): Promise<string> {
    const res = await challengeRoute.POST(
      request('POST', '/api/v1/guests/challenge', { headers: { 'x-forwarded-for': freshIp() } })
    );
    expect(res.status).toBe(201);
    return (await res.json()).challenge;
  }

  async function create(body?: unknown) {
    return guestsRoute.POST(
      request('POST', '/api/v1/guests', { body, headers: { 'x-forwarded-for': freshIp() } })
    );
  }

  it('refuses a request with no attestation', async () => {
    const res = await create();
    expect(res.status).toBe(400);
    expect((await res.json()).error.fields).toEqual({ attestation: 'Required' });
  });

  it('refuses a challenge it never issued', async () => {
    const res = await create({ attestation: { ...ATTESTATION, challenge: 'made-up' } });
    expect(res.status).toBe(403);
    expect(appAttest.verifyAttestation).not.toHaveBeenCalled();
  });

  it('refuses an attestation that does not verify, and spends the challenge doing it', async () => {
    const issued = await challenge();
    const first = await create({ attestation: { ...ATTESTATION, challenge: issued } });
    expect(first.status).toBe(403);
    await expect(first.json()).resolves.toEqual({
      error: { code: 'FORBIDDEN', message: 'This device could not be verified.' },
    });

    // The same challenge cannot be tried twice, even after a failure.
    appAttest.verifyAttestation.mockReturnValue({ keyId: 'a2V5', environment: 'production' });
    const replay = await create({ attestation: { ...ATTESTATION, challenge: issued } });
    expect(replay.status).toBe(403);
  });

  it('creates a guest for a verified key, once per live guest', async () => {
    const keyId = `key-${Date.now()}`;
    appAttest.verifyAttestation.mockReturnValue({ keyId, environment: 'production' });

    const res = await create({
      attestation: { ...ATTESTATION, keyId, challenge: await challenge() },
    });
    expect(res.status).toBe(201);
    const first = (await res.json()).user.id;
    guestIds.push(first);

    // Verified against our app, with the challenge's own bytes.
    expect(appAttest.verifyAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'K555FJZF47.com.brambleworld.BrambleMobile',
        environment: 'production',
      })
    );
    const [row] = await db.select().from(users).where(eq(users.id, first));
    expect(row.appAttestKeyId).toBe(keyId);

    // A second live guest for the same key is refused.
    const second = await create({
      attestation: { ...ATTESTATION, keyId, challenge: await challenge() },
    });
    expect(second.status).toBe(409);

    // Once the first has expired, the key may start again — even before the
    // sweep has reached it.
    await db
      .update(users)
      .set({ guestExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, first));
    const third = await create({
      attestation: { ...ATTESTATION, keyId, challenge: await challenge() },
    });
    expect(third.status).toBe(201);
    guestIds.push((await third.json()).user.id);
    expect(await db.select().from(users).where(eq(users.id, first))).toHaveLength(0);
  });
});
