import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * The route handlers, against a real database and the fake generator.
 *
 * This is the primary verification layer for the API, not the Playwright suite:
 * CI runs with no secrets at all, so nothing there can authenticate, and that
 * property is worth keeping. Here `requireCurrentUser` is mocked to a seeded
 * user and everything below it — ownership, views, transactions, constraints —
 * is the real thing.
 *
 * `@/env` is forced to fake mode rather than the generator being stubbed, so
 * `getGenerator()` runs its own selection logic and the paid endpoint is
 * exercised through the same code path production uses. Spending real money in
 * a test suite is one forgotten mock away otherwise.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});
vi.mock('@/lib/services/auth/auth.service', () => ({ requireCurrentUser: vi.fn() }));

const { db } = await import('@/index');
const { storylines: storylineTable, users } = await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const persons = await import('@/lib/services/persons/persons.service');
const storylines = await import('@/lib/services/storylines/storylines.service');
const sessions = await import('@/lib/services/sessions/sessions.service');
const timeline = await import('@/lib/services/timeline/timeline.service');

const world = await import('@/app/api/v1/world/route');
const preferencesRoute = await import('@/app/api/v1/me/preferences/route');
const userReader = await import('@/lib/services/users/users.reader');
const meRoute = await import('@/app/api/me/route');
const personRoute = await import('@/app/api/v1/people/[personId]/route');
const storylineRoute = await import('@/app/api/v1/storylines/[storylineId]/route');
const startRoute = await import('@/app/api/v1/storylines/[storylineId]/sessions/route');
const sessionRoute = await import('@/app/api/v1/sessions/[sessionId]/route');
const answerRoute = await import('@/app/api/v1/sessions/[sessionId]/answer/route');
const turnRoute = await import('@/app/api/v1/sessions/[sessionId]/turn/route');

/** The ending, in one sentence. Never leaves the server. */
const ARC_SUMMARY = 'It begins badly and ends with them reconciled on a rooftop.';

const OWNER = 'user_api_owner';
const STRANGER = 'user_api_stranger';

let ownerId: string;
let storylineId: string;
let mayaPersonId: string;

const get = (path: string) => new Request(`http://api.test${path}`);
const post = (path: string, body?: unknown) =>
  new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Every handler takes `{ params }` and Next 16 makes that a promise. */
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

/**
 * Resolves the real row rather than a literal `{ id }`.
 *
 * Handlers read more than the id off `PublicUser` — `clerkId` to address a
 * write, `shareUsage` to render a preference — and a static stub makes those
 * undefined, which surfaces as a 500 far from the cause. Reading the row also
 * means a response reflects a change a previous request made.
 */
const resolveAs = (clerkId: string) =>
  auth.requireCurrentUser.mockImplementation(async () => {
    const user = await userReader.getUserByClerkId(clerkId);
    if (!user) throw new Error(`test fixture: no user for ${clerkId}`);
    return user;
  });

const asOwner = () => resolveAs(OWNER);
const asStranger = () => resolveAs(STRANGER);

async function seedUser(clerkId: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ clerkId, email: `${clerkId}@api.local` })
    .returning({ id: users.id });
  return user.id;
}

beforeAll(async () => {
  for (const clerkId of [OWNER, STRANGER]) {
    await db.delete(users).where(eq(users.clerkId, clerkId));
  }
});

afterAll(async () => {
  for (const clerkId of [OWNER, STRANGER]) {
    await db.delete(users).where(eq(users.clerkId, clerkId));
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const clerkId of [OWNER, STRANGER]) {
    await db.delete(users).where(eq(users.clerkId, clerkId));
  }
  ownerId = await seedUser(OWNER);
  await seedUser(STRANGER);

  const storyline = await storylines.createStoryline(ownerId, {
    title: 'The Unsent Apology',
    sourceSurface: 'imessage',
    setting: 'Two flats and a group chat, March to June.',
    tone: 'wistful',
  });
  storylineId = storyline.id;
  await storylines.markStatus(ownerId, storylineId, 'ready');
  // Written directly: `arcSummary` describes the whole arc including beats above
  // the playhead, and the only way to prove a view does not ship it is for there
  // to be one to ship.
  await db
    .update(storylineTable)
    .set({ arcSummary: ARC_SUMMARY, arcSummaryGeneratedAt: new Date() })
    .where(eq(storylineTable.id, storylineId));

  const self = await persons.getOrCreateSelfPerson(ownerId, 'Blossom');
  const maya = await persons.createPerson(ownerId, { name: 'Maya' });
  const michael = await persons.createPerson(ownerId, { name: 'Michael' });
  mayaPersonId = maya.id;

  const a = await storylines.castCharacter(ownerId, storylineId, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(ownerId, storylineId, maya.id);
  const c = await storylines.castCharacter(ownerId, storylineId, michael.id, {
    // A description written by extraction, which has read the whole
    // conversation. This is the leak the met-cut exists for.
    description: 'the investor who offers $300,000',
  });
  await persons.linkPersons(ownerId, self.id, maya.id, 'oldest friend');

  // Maya is in the first beat, Michael only in the third — so who the reader has
  // met depends entirely on where the playhead is. Scores are spread so the ranked
  // read has something to order, and `stakes` is planted on every beat so the
  // no-machinery assertion has something it could leak.
  await timeline.appendEvent(ownerId, storylineId, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in three weeks.',
    stakes: 'Whether it gets named at all.',
    participantCharacterIds: [a.id, b.id],
    engagementScore: 4,
  });
  await timeline.appendEvent(ownerId, storylineId, {
    origin: 'extracted',
    title: 'The message',
    description: 'She wrote first.',
    stakes: 'Whether she answers.',
    participantCharacterIds: [a.id, b.id],
    engagementScore: 9,
  });
  await timeline.appendEvent(ownerId, storylineId, {
    origin: 'extracted',
    title: 'The offer',
    description: 'Michael names a number.',
    stakes: 'Whether the $300,000 is taken.',
    participantCharacterIds: [a.id, c.id],
    engagementScore: 6,
  });
});

describe('PUT /api/v1/me/preferences', () => {
  const put = (body: unknown) =>
    new Request('http://api.test/api/v1/me/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('round-trips the analytics opt-out', async () => {
    asOwner();

    const off = await preferencesRoute.PUT(put({ shareUsage: false }), undefined);
    expect(off.status).toBe(200);
    expect(await off.json()).toStrictEqual({ shareUsage: false });

    const on = await preferencesRoute.PUT(put({ shareUsage: true }), undefined);
    expect(await on.json()).toStrictEqual({ shareUsage: true });
  });

  // The Mac reads the current value here rather than making a second request.
  it('is reflected by GET /api/me', async () => {
    asOwner();
    await preferencesRoute.PUT(put({ shareUsage: false }), undefined);

    const me = await (await meRoute.GET(get('/api/me'))).json();

    expect(me).toMatchObject({ id: ownerId, shareUsage: false });
    // clerkId is an internal join key and never ships.
    expect(me).not.toHaveProperty('clerkId');
  });

  it('defaults to sharing for a reader who has never chosen', async () => {
    asOwner();

    expect((await (await meRoute.GET(get('/api/me'))).json()).shareUsage).toBe(true);
  });

  it('answers 400 for a body that is not a boolean', async () => {
    asOwner();

    const response = await preferencesRoute.PUT(put({ shareUsage: 'yes' }), undefined);

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields).toHaveProperty('shareUsage');
  });

  it('never changes another reader preference', async () => {
    asOwner();
    await preferencesRoute.PUT(put({ shareUsage: false }), undefined);

    asStranger();
    const theirs = await (await meRoute.GET(get('/api/me'))).json();

    expect(theirs.shareUsage).toBe(true);
  });
});

describe('GET /api/v1/world', () => {
  /**
   * "Not enough context yet" is an invitation, not a failure. A 404 would make the
   * client render an error where it should render that, and "empty becomes 404" is
   * the easiest mistake in this service.
   */
  it('gives a reader with nothing 200 and an empty world', async () => {
    asStranger();

    const response = await world.GET(get('/api/v1/world'), undefined);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.events).toStrictEqual([]);
    expect(body.truncated).toBe(false);
    // A reader with nothing has spent nothing, so a full balance and no reset.
    expect(body.energy).toStrictEqual({ remaining: 20, limit: 20, resetsAt: null });
  });

  it('never serves one reader another reader moments', async () => {
    asOwner();
    const mine = await (await world.GET(get('/api/v1/world'), undefined)).json();

    asStranger();
    const theirs = await (await world.GET(get('/api/v1/world'), undefined)).json();

    expect(mine.events.length).toBeGreaterThan(0);
    expect(theirs.events).toStrictEqual([]);
  });

  it('returns the best beats first, each knowing which story it belongs to', async () => {
    asOwner();

    const body = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const scores = body.events.map((e: { score: number }) => e.score);

    expect(body.events.length).toBeGreaterThan(1);
    expect(scores).toStrictEqual([...scores].sort((a: number, b: number) => b - a));
    expect(body.events[0].storylineTitle).toBe('The Unsent Apology');
    expect(body.events[0].eventId).toEqual(expect.any(String));
  });

  // Everything the card draws, in one request: title, date, paragraph, people.
  it('sends everything the card renders', async () => {
    asOwner();

    const body = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const top = body.events[0];

    expect(top).toMatchObject({
      title: 'The message',
      description: 'She wrote first.',
      storylineTitle: 'The Unsent Apology',
    });
    expect(top.occurredAt === null || typeof top.occurredAt === 'string').toBe(true);
    expect(top.people.map((p: { name: string }) => p.name)).toStrictEqual(['Blossom', 'Maya']);
    expect(top.people[0].isSelf).toBe(true);
  });

  it('sends the weight and the raw score it came from', async () => {
    asOwner();

    const body = await (await world.GET(get('/api/v1/world'), undefined)).json();

    expect(body.events[0].weight).toBe(1);
    expect(body.events[0].score).toBeGreaterThan(0);
    for (const event of body.events) {
      expect(event.weight).toBeGreaterThan(0);
      expect(event.weight).toBeLessThanOrEqual(1);
    }
  });

  it('honours a limit, clamped to the ceiling', async () => {
    asOwner();

    const one = await (await world.GET(get('/api/v1/world?limit=1'), undefined)).json();
    const absurd = await (await world.GET(get('/api/v1/world?limit=9999'), undefined)).json();

    expect(one.events).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect(absurd.events.length).toBeLessThanOrEqual(20);
  });

  /**
   * The list names beats the reader has not reached, deliberately — that is what
   * makes "play from here" possible. What it must never carry is the machinery:
   * `stakes` is the lever, `generationRationale` is the model explaining its trick,
   * and `narrativeOrder` is an internal key the client never needs because it
   * starts a session from `eventId`.
   */
  it('names beats without shipping the machinery behind them', async () => {
    asOwner();

    const raw = await (await world.GET(get('/api/v1/world'), undefined)).text();

    expect(raw).not.toContain('stakes');
    expect(raw).not.toContain('generationRationale');
    expect(raw).not.toContain('narrativeOrder');
    expect(raw).not.toContain('$300,000');
    expect(raw).not.toContain('rooftop');
  });

  // The home screen is where a reader decides whether to play, so it is where
  // the balance belongs. Account state beside the resource, never inside it.
  it('carries the energy balance', async () => {
    asOwner();

    const body = await (await world.GET(get('/api/v1/world'), undefined)).json();

    expect(body.energy).toMatchObject({ limit: 20 });
    expect(body.energy.remaining).toBeLessThanOrEqual(20);
  });

  it('is never cached by anything in front of it', async () => {
    asOwner();
    const response = await world.GET(get('/api/v1/world'), undefined);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('GET /api/v1/people/:personId', () => {
  it('gives a person their relationship and the arcs they are in', async () => {
    asOwner();

    const response = await personRoute.GET(
      get(`/api/v1/people/${mayaPersonId}`),
      ctx({ personId: mayaPersonId })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.person.name).toBe('Maya');
    expect(body.person.relationshipType).toBe('oldest friend');
    expect(body.person.arcs).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('rooftop');
    expect(body.person.arcs[0]).toMatchObject({
      storylineId,
      title: 'The Unsent Apology',
      role: 'supporting',
      startable: true,
      lastPlayedAt: null,
    });
  });

  // 404 and not 403: "not yours" and "no such thing" must be the same answer, or
  // the error itself confirms the id exists.
  it("answers 404 for another reader's person", async () => {
    asStranger();

    const response = await personRoute.GET(
      get(`/api/v1/people/${mayaPersonId}`),
      ctx({ personId: mayaPersonId })
    );

    expect(response.status).toBe(404);
  });

  /**
   * Without this the malformed id reaches Postgres, which rejects the cast, and
   * a bad request is reported to the client as an internal error.
   */
  it('answers 400 for an id that is not a uuid', async () => {
    asOwner();

    const response = await personRoute.GET(
      get('/api/v1/people/not-a-uuid'),
      ctx({ personId: 'not-a-uuid' })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/storylines/:storylineId', () => {
  /**
   * The demonstrated leak, not a hypothetical one: Michael's description was
   * written by extraction from the whole conversation and says what he offers.
   * He appears only in the third beat, so before the reader gets there he must
   * not be on the screen at all.
   */
  it('shows only the people the reader has met', async () => {
    asOwner();
    await sessions.startSession(ownerId, storylineId);

    const response = await storylineRoute.GET(
      get(`/api/v1/storylines/${storylineId}`),
      ctx({ storylineId })
    );
    const body = await response.json();

    const names = body.storyline.cast.map((p: { name: string }) => p.name);
    expect(names).toContain('Maya');
    expect(names).not.toContain('Michael');
  });

  /**
   * Two leaks, one assertion. `arcSummary` describes the whole arc — the app has
   * a playhead specifically to keep that from the model, and serving it to the
   * reader is the same leak on a screen. `description` is what extraction wrote
   * about a character after reading everything.
   */
  it('never returns the arc summary or a cast description', async () => {
    asOwner();
    await sessions.startSession(ownerId, storylineId);

    const response = await storylineRoute.GET(
      get(`/api/v1/storylines/${storylineId}`),
      ctx({ storylineId })
    );
    const raw = await response.text();

    expect(raw).not.toContain('rooftop');
    expect(raw).not.toContain('$300,000');
  });

  it("answers 404 for another reader's storyline", async () => {
    asStranger();

    const response = await storylineRoute.GET(
      get(`/api/v1/storylines/${storylineId}`),
      ctx({ storylineId })
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /api/v1/storylines/:storylineId/sessions', () => {
  it('starts a playthrough from a body-less POST', async () => {
    asOwner();

    const response = await startRoute.POST(
      post(`/api/v1/storylines/${storylineId}/sessions`),
      ctx({ storylineId })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.session.storylineId).toBe(storylineId);
    expect(body.session.state).toBe('awaiting_turn');
    expect(body.session.turn).toBeNull();
  });

  /**
   * A double tap, a retried request, a screen restored from the background. A
   * second playthrough with its own playhead would lose the reader their place
   * with nothing anywhere to report it.
   */
  it('resumes rather than restarting', async () => {
    asOwner();

    const first = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`),
        ctx({ storylineId })
      )
    ).json();
    const second = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`, {}),
        ctx({ storylineId })
      )
    ).json();

    expect(second.session.id).toBe(first.session.id);
  });

  it('starts a fresh playthrough on request', async () => {
    asOwner();

    const first = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`),
        ctx({ storylineId })
      )
    ).json();
    const replay = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`, { mode: 'new' }),
        ctx({ storylineId })
      )
    ).json();

    expect(replay.session.id).not.toBe(first.session.id);
  });

  it("answers 404 for another reader's storyline", async () => {
    asStranger();

    const response = await startRoute.POST(
      post(`/api/v1/storylines/${storylineId}/sessions`),
      ctx({ storylineId })
    );

    expect(response.status).toBe(404);
  });

  /**
   * The whole handoff the world screen exists for: read the twenty moments, pick
   * one, play from it. Driven through both routes rather than asserted on the
   * service, because the id the client sends is the one `/world` gave it and
   * nothing else guarantees those are the same thing.
   */
  it('starts a playthrough at a moment taken from the world screen', async () => {
    asOwner();

    const world_ = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const picked = world_.events[0];

    const response = await startRoute.POST(
      post(`/api/v1/storylines/${picked.storylineId}/sessions`, { fromEventId: picked.eventId }),
      ctx({ storylineId: picked.storylineId })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.session.storylineId).toBe(picked.storylineId);
    expect(body.session.state).toBe('awaiting_turn');

    // And the turn generated from there follows the chosen beat rather than the
    // opening one — which is the only observable difference that matters.
    const { turn } = await (
      await turnRoute.POST(
        post(`/api/v1/sessions/${body.session.id}/turn`),
        ctx({ sessionId: body.session.id })
      )
    ).json();
    expect(turn.choices.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * The resume loop the world card depends on: tap a moment, play, come back,
   * tap the same moment, and land in the same playthrough with its history.
   */
  it('returns the same playthrough when the same moment is tapped again', async () => {
    asOwner();
    const world_ = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const picked = world_.events[0];
    const body = { fromEventId: picked.eventId };

    const first = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${picked.storylineId}/sessions`, body),
        ctx({ storylineId: picked.storylineId })
      )
    ).json();
    const again = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${picked.storylineId}/sessions`, body),
        ctx({ storylineId: picked.storylineId })
      )
    ).json();

    expect(again.session.id).toBe(first.session.id);
  });

  it('starts another playthrough of the same moment when asked', async () => {
    asOwner();
    const world_ = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const picked = world_.events[0];

    const first = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${picked.storylineId}/sessions`, { fromEventId: picked.eventId }),
        ctx({ storylineId: picked.storylineId })
      )
    ).json();
    const replay = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${picked.storylineId}/sessions`, {
          fromEventId: picked.eventId,
          mode: 'new',
        }),
        ctx({ storylineId: picked.storylineId })
      )
    ).json();

    expect(replay.session.id).not.toBe(first.session.id);
  });

  it('starts fresh rather than resuming a session begun from the top', async () => {
    asOwner();

    const first = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`),
        ctx({ storylineId })
      )
    ).json();

    const world_ = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const picked = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`, {
          mode: 'resume',
          fromEventId: world_.events[0].eventId,
        }),
        ctx({ storylineId })
      )
    ).json();

    expect(picked.session.id).not.toBe(first.session.id);
  });

  // Every SessionView carries history, including a brand-new one.
  it('gives a new playthrough an empty history rather than omitting it', async () => {
    asOwner();

    const body = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`),
        ctx({ storylineId })
      )
    ).json();

    expect(body.session.history).toStrictEqual([]);
  });

  it('answers 404 for a moment from a different storyline', async () => {
    asOwner();
    const other = await storylines.createStoryline(ownerId, {
      title: 'Elsewhere',
      sourceSurface: 'imessage',
    });
    await storylines.markStatus(ownerId, other.id, 'ready');
    const elsewhere = await timeline.appendEvent(ownerId, other.id, {
      origin: 'extracted',
      title: 'not in this story',
      description: 'x',
      participantCharacterIds: [],
      engagementScore: 5,
    });

    const response = await startRoute.POST(
      post(`/api/v1/storylines/${storylineId}/sessions`, { fromEventId: elsewhere.id }),
      ctx({ storylineId })
    );

    expect(response.status).toBe(404);
  });

  it('answers 400 for a moment id that is not a uuid', async () => {
    asOwner();

    const response = await startRoute.POST(
      post(`/api/v1/storylines/${storylineId}/sessions`, { fromEventId: 'not-a-uuid' }),
      ctx({ storylineId })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields).toHaveProperty('fromEventId');
  });
});

describe('the play loop', () => {
  let sessionId: string;

  beforeEach(async () => {
    asOwner();
    sessionId = (await sessions.startSession(ownerId, storylineId)).id;
  });

  it('brings a session to a playable state and returns what to show', async () => {
    const response = await turnRoute.POST(
      post(`/api/v1/sessions/${sessionId}/turn`),
      ctx({ sessionId })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.turn.headline).toEqual(expect.any(String));
    expect(body.turn.narrative).toEqual(expect.any(String));
    expect(body.turn.choices.length).toBeGreaterThanOrEqual(2);
    // Always present — empty for a text-only beat, never absent.
    expect(body.turn.surfaces).toEqual(expect.any(Array));
  });

  // Same URL is the loop, the resume and the retry. A second call must find the
  // work done rather than pay for it again.
  it('returns the same turn when called twice', async () => {
    const first = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();
    const again = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();

    expect(again.turn.id).toBe(first.turn.id);
  });

  it('reports the session as awaiting an answer once a turn is open', async () => {
    await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }));

    const body = await (
      await sessionRoute.GET(get(`/api/v1/sessions/${sessionId}`), ctx({ sessionId }))
    ).json();

    expect(body.session.state).toBe('awaiting_answer');
    expect(body.session.turn.choices.length).toBeGreaterThanOrEqual(2);
    expect(body.session.turnsAnswered).toBe(0);
  });

  /**
   * The balance is read after the turn is written, so the response that spent a
   * point already shows it gone. A stale balance here would show a reader energy
   * they no longer have.
   */
  it('returns the balance the turn just spent from', async () => {
    const before = await (
      await sessionRoute.GET(get(`/api/v1/sessions/${sessionId}`), ctx({ sessionId }))
    ).json();

    const body = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();

    expect(body.energy.remaining).toBe(before.energy.remaining - 1);
    expect(body.energy.limit).toBe(20);
    expect(typeof body.energy.resetsAt).toBe('string');
  });

  it('records an answer and moves the session on', async () => {
    const { turn } = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();

    const response = await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, {
        turnId: turn.id,
        choiceId: turn.choices[0].id,
      }),
      ctx({ sessionId })
    );

    expect(response.status).toBe(200);

    const after = await (
      await sessionRoute.GET(get(`/api/v1/sessions/${sessionId}`), ctx({ sessionId }))
    ).json();
    expect(after.session.state).toBe('awaiting_turn');
    expect(after.session.turnsAnswered).toBe(1);
  });

  /**
   * The retry whose first response was lost. The client fires the next turn the
   * instant an answer lands, so this is a likely path — and a 409 would strand
   * it on an operation that actually succeeded.
   */
  it('reconciles a repeated answer instead of conflicting', async () => {
    const { turn } = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();
    const body = { turnId: turn.id, choiceId: turn.choices[0].id };

    await answerRoute.POST(post(`/api/v1/sessions/${sessionId}/answer`, body), ctx({ sessionId }));
    const retry = await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, body),
      ctx({ sessionId })
    );

    expect(retry.status).toBe(200);
  });

  it('refuses a second, different answer to the same turn', async () => {
    const { turn } = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();

    await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, {
        turnId: turn.id,
        choiceId: turn.choices[0].id,
      }),
      ctx({ sessionId })
    );
    const response = await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, {
        turnId: turn.id,
        choiceId: turn.choices[1].id,
      }),
      ctx({ sessionId })
    );

    expect(response.status).toBe(409);
  });

  /**
   * The session in the URL and the turn in the body are two separate claims.
   * Checking only the second would let a client answer a turn of its own from
   * whatever session it happened to name.
   */
  it('refuses a turn that belongs to a different session', async () => {
    const { turn } = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();
    const elsewhere = (await sessions.startSession(ownerId, storylineId)).id;

    const response = await answerRoute.POST(
      post(`/api/v1/sessions/${elsewhere}/answer`, {
        turnId: turn.id,
        choiceId: turn.choices[0].id,
      }),
      ctx({ sessionId: elsewhere })
    );

    expect(response.status).toBe(404);
  });

  it('answers 400 when the body is missing the turn id', async () => {
    const response = await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, { choiceId: crypto.randomUUID() }),
      ctx({ sessionId })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields).toHaveProperty('turnId');
  });

  it("answers 404 on another reader's session, on every verb", async () => {
    asStranger();

    const probe = await sessionRoute.GET(get(`/api/v1/sessions/${sessionId}`), ctx({ sessionId }));
    const advance = await turnRoute.POST(
      post(`/api/v1/sessions/${sessionId}/turn`),
      ctx({ sessionId })
    );
    const answer = await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, {
        turnId: crypto.randomUUID(),
        choiceId: crypto.randomUUID(),
      }),
      ctx({ sessionId })
    );

    expect([probe.status, advance.status, answer.status]).toStrictEqual([404, 404, 404]);
  });

  /**
   * A storyline can fail after a session has begun. `blocked` is a live check,
   * not something settled at start, or the client gets a 500 from a generation
   * that never had a chance.
   */
  it('reports a session as blocked when its storyline stops being playable', async () => {
    await storylines.markFailed(ownerId, storylineId, 'extraction gave up');

    const body = await (
      await sessionRoute.GET(get(`/api/v1/sessions/${sessionId}`), ctx({ sessionId }))
    ).json();

    expect(body.session.state).toBe('blocked');
  });
});

describe('a moment you have already played', () => {
  /**
   * The field that turns "play" into "continue" on the card, and the whole loop
   * it serves: pick a moment, answer a turn, and the card knows you have been
   * there and how far you got.
   */
  it('reports the playthrough, and its progress, against the moment it started from', async () => {
    asOwner();
    const before = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const picked = before.events[0];
    expect(picked.playthrough).toBeNull();

    const { session } = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${picked.storylineId}/sessions`, { fromEventId: picked.eventId }),
        ctx({ storylineId: picked.storylineId })
      )
    ).json();
    const { turn } = await (
      await turnRoute.POST(
        post(`/api/v1/sessions/${session.id}/turn`),
        ctx({ sessionId: session.id })
      )
    ).json();
    await answerRoute.POST(
      post(`/api/v1/sessions/${session.id}/answer`, {
        turnId: turn.id,
        choiceId: turn.choices[0].id,
      }),
      ctx({ sessionId: session.id })
    );

    const after = await (await world.GET(get('/api/v1/world'), undefined)).json();
    const played = after.events.find((e: { eventId: string }) => e.eventId === picked.eventId);

    expect(played.playthrough).toMatchObject({ sessionId: session.id, turnsAnswered: 1 });
    expect(typeof played.playthrough.lastActiveAt).toBe('string');
    // Only the moment that was played. The rest are still untouched.
    for (const event of after.events.filter(
      (e: { eventId: string }) => e.eventId !== picked.eventId
    )) {
      expect(event.playthrough).toBeNull();
    }
  });

  /**
   * History is what a reader resuming after a week needs: the decisions they
   * already made. The open turn is deliberately absent — it is returned as
   * `turn`, and carrying it in both would make the client render it twice.
   */
  it('accumulates answered turns in order, without repeating the open one', async () => {
    asOwner();
    const { session } = await (
      await startRoute.POST(
        post(`/api/v1/storylines/${storylineId}/sessions`),
        ctx({ storylineId })
      )
    ).json();

    const answered: string[] = [];
    const chosen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { turn } = await (
        await turnRoute.POST(
          post(`/api/v1/sessions/${session.id}/turn`),
          ctx({ sessionId: session.id })
        )
      ).json();
      answered.push(turn.id);
      chosen.push(turn.choices[0].id);
      await answerRoute.POST(
        post(`/api/v1/sessions/${session.id}/answer`, {
          turnId: turn.id,
          choiceId: turn.choices[0].id,
        }),
        ctx({ sessionId: session.id })
      );
    }

    // A third turn, left open.
    const { turn: open } = await (
      await turnRoute.POST(
        post(`/api/v1/sessions/${session.id}/turn`),
        ctx({ sessionId: session.id })
      )
    ).json();

    const body = await (
      await sessionRoute.GET(get(`/api/v1/sessions/${session.id}`), ctx({ sessionId: session.id }))
    ).json();

    expect(body.session.history.map((h: { turn: { id: string } }) => h.turn.id)).toStrictEqual(
      answered
    );
    expect(
      body.session.history.map((h: { chosenChoiceId: string }) => h.chosenChoiceId)
    ).toStrictEqual(chosen);
    expect(body.session.turn.id).toBe(open.id);
    expect(body.session.history.map((h: { turn: { id: string } }) => h.turn.id)).not.toContain(
      open.id
    );
    // Each history entry is a full turn, so the client can render what was asked.
    expect(body.session.history[0].turn.choices.length).toBeGreaterThanOrEqual(2);
    expect(body.session.history[0].turn.surfaces).toEqual(expect.any(Array));
  });
});

describe('the world after playing', () => {
  /**
   * Playing changes nothing about the offer. The list is extracted beats — the
   * script the reader can enter at — and a beat they caused is not an entry point,
   * so a generated beat must not appear however highly the model scored it.
   */
  it('still offers only the imported beats after a turn is played', async () => {
    asOwner();
    const before = await (await world.GET(get('/api/v1/world'), undefined)).json();

    const sessionId = (await sessions.startSession(ownerId, storylineId)).id;
    const { turn } = await (
      await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }))
    ).json();
    await answerRoute.POST(
      post(`/api/v1/sessions/${sessionId}/answer`, {
        turnId: turn.id,
        choiceId: turn.choices[0].id,
      }),
      ctx({ sessionId })
    );
    // Settling writes a scored, generated beat — the fake scores consequences 7.
    await turnRoute.POST(post(`/api/v1/sessions/${sessionId}/turn`), ctx({ sessionId }));

    const after = await (await world.GET(get('/api/v1/world'), undefined)).json();

    expect(after.events.map((e: { eventId: string }) => e.eventId)).toStrictEqual(
      before.events.map((e: { eventId: string }) => e.eventId)
    );
  });

  // Every moment offered carries the id a session is started from, and nothing
  // that would let a client derive a position itself.
  it('gives each moment an id a session can be started from', async () => {
    asOwner();

    const body = await (await world.GET(get('/api/v1/world'), undefined)).json();

    for (const event of body.events) {
      expect(event.eventId).toEqual(expect.any(String));
      expect(event.storylineId).toBe(storylineId);
      expect(event).not.toHaveProperty('narrativeOrder');
    }
  });
});
