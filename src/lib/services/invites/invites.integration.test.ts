import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';

/**
 * Invites and stories for two, end to end against a real database and the
 * fake model: the routes, accepting once, both sides made and cast, the side
 * coming next on each desk, and the rename when a player leaves.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});
vi.mock('@/lib/services/auth/auth.service', () => ({ requireCurrentUser: vi.fn() }));

const { db } = await import('@/index');
const { characters, duets, events, invites, persons, storylines, storyTemplates, users } =
  await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');
const { SEED_STORIES } = await import('@/lib/pool/seeds');
const { advanceSession, commitChoice } = await import('../generation/turns.service');
const sessions = await import('../sessions/sessions.service');
const { instantiateTemplate, nextStoryFor, startNextStory } = await import('../pool/next.service');
const { acceptInvite, createInvite, MAX_INVITES_PER_DAY, MAX_OPEN_INVITES, readInvite } =
  await import('./invites.service');
const { purgeUsersByEmail } = await import('../users/users.writer');
const { InviteExpiredError, InviteUsedError, OwnInviteError, RateLimitError } =
  await import('@/lib/utils/errors');
const createRoute = await import('@/app/api/v1/invites/route');
const readRoute = await import('@/app/api/v1/invites/[code]/route');
const acceptRoute = await import('@/app/api/v1/invites/[code]/accept/route');

const CLERK = 'user_invites_';
const SEED_SLUG = 'invites-test-seed';
const fake = createFakeGenerator();
registerFixtures(fake);
let seedId: string;

async function newUser(name: string, isGuest = false) {
  const [user] = await db
    .insert(users)
    .values({ clerkId: `${CLERK}${name}`, email: `${name}@invites.local`, isGuest })
    .returning({ id: users.id });
  await db.insert(persons).values({ userId: user.id, name: 'You', isSelf: true });
  return user.id;
}

const as = (id: string, isGuest = false) =>
  auth.requireCurrentUser.mockResolvedValue({ id, isGuest } as never);
const post = (url: string, body: unknown) =>
  new Request(`http://api.test${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ctx = (code: string) => ({ params: Promise.resolve({ code }) });

/** Plays a seed story to its ending, so the next story is offered. */
async function finishAStory(userId: string) {
  const sessionId = await db.transaction((tx) =>
    instantiateTemplate(tx, userId, seedId, SEED_STORIES['close-friends'])
  );
  const session = await sessions.getSession(userId, sessionId);
  await db.update(storylines).set({ targetBeats: 6 }).where(eq(storylines.id, session.storylineId));
  const first = await advanceSession(userId, sessionId, { generator: fake });
  await commitChoice(userId, first.id, first.choices[0].id);
  const ending = await advanceSession(userId, sessionId, { generator: fake });
  expect(ending.isEnding).toBe(true);
  return sessionId;
}

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  await db.delete(storyTemplates).where(eq(storyTemplates.slug, SEED_SLUG));
  [{ id: seedId }] = await db
    .insert(storyTemplates)
    .values({
      origin: 'seed',
      slug: SEED_SLUG,
      status: 'ready',
      content: SEED_STORIES['close-friends'],
    })
    .returning({ id: storyTemplates.id });
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  auth.requireCurrentUser.mockReset();
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  await db.delete(storyTemplates).where(eq(storyTemplates.slug, SEED_SLUG));
});

describe('the invite routes', () => {
  it('makes an invite for an account, refuses a guest, and shows it to anyone', async () => {
    const maya = await newUser('maya');
    as(maya);
    const made = await createRoute.POST(
      post('/api/v1/invites', { firstName: ' Maya ' }),
      undefined as never
    );
    expect(made.status).toBe(201);
    const { invite } = await made.json();
    expect(invite.code).toMatch(/^[A-Z]{6}$/);
    expect(invite.url).toBe(`https://www.brambleworld.com/invite/${invite.code}`);

    const guest = await newUser('guest', true);
    as(guest, true);
    const refused = await createRoute.POST(
      post('/api/v1/invites', { firstName: 'Sam' }),
      undefined as never
    );
    expect(refused.status).toBe(403);

    const read = await readRoute.GET(
      new Request('http://api.test/x'),
      ctx(invite.code.toLowerCase())
    );
    expect(read.status).toBe(200);
    expect((await read.json()).invite).toMatchObject({ inviterFirstName: 'Maya', state: 'open' });

    const acceptAsGuest = await acceptRoute.POST(
      post(`/api/v1/invites/${invite.code}/accept`, { firstName: 'Sam' }),
      ctx(invite.code)
    );
    expect(acceptAsGuest.status).toBe(403);
  });

  it('refuses a first name that is not one: 400', async () => {
    as(await newUser('maya'));
    const response = await createRoute.POST(
      post('/api/v1/invites', { firstName: '@@' }),
      undefined as never
    );
    expect(response.status).toBe(400);
  });

  it('answers an unknown code with 404', async () => {
    as(await newUser('maya'));
    const response = await readRoute.GET(new Request('http://api.test/x'), ctx('ZZZZZZ'));
    expect(response.status).toBe(404);
  });
});

describe('accepting', () => {
  it('makes a story for two: a side each, the other cast by the name they gave', async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const { code } = await createInvite(maya, 'Maya');

    const { duetId } = await acceptInvite(sam, code, 'Sam');

    const [duet] = await db.select().from(duets).where(eq(duets.id, duetId));
    expect(duet).toMatchObject({
      sideAUserId: maya,
      sideBUserId: sam,
      sideAName: 'Maya',
      sideBName: 'Sam',
    });
    const sides = await db.select().from(storyTemplates).where(eq(storyTemplates.duetId, duetId));
    expect(sides.map((s) => [s.userId, s.origin, s.status]).sort()).toEqual(
      [
        [maya, 'duet', 'ready'],
        [sam, 'duet', 'ready'],
      ].sort()
    );
    const mayaSide = sides.find((s) => s.userId === maya)!;
    const samSide = sides.find((s) => s.userId === sam)!;
    expect(mayaSide.content!.cast[duet.sideAPartnerIndex].name).toBe('Sam');
    expect(samSide.content!.cast[duet.sideBPartnerIndex].name).toBe('Maya');
    expect(JSON.stringify(mayaSide.content)).not.toContain('{partner}');

    expect(await readInvite(code)).toMatchObject({ state: 'accepted' });
  });

  it('is once only: the same player gets the same story, anyone else is told it is used', async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const ana = await newUser('ana');
    const { code } = await createInvite(maya, 'Maya');
    const first = await acceptInvite(sam, code, 'Sam');
    expect(await acceptInvite(sam, code, 'Sam')).toEqual(first);
    await expect(acceptInvite(ana, code, 'Ana')).rejects.toBeInstanceOf(InviteUsedError);
    expect(await db.select().from(duets).where(eq(duets.sideAUserId, maya))).toHaveLength(1);
  });

  it('refuses your own invite, and one past its 7 days', async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const { code } = await createInvite(maya, 'Maya');
    await expect(acceptInvite(maya, code, 'Maya')).rejects.toBeInstanceOf(OwnInviteError);

    const old = await createInvite(maya, 'Maya', new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    expect(await readInvite(old.code)).toMatchObject({ state: 'expired' });
    await expect(acceptInvite(sam, old.code, 'Sam')).rejects.toBeInstanceOf(InviteExpiredError);
  });

  it('never gives a pair the same premise twice while there are others', async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const premises = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const { code } = await createInvite(maya, 'Maya');
      const { duetId } = await acceptInvite(sam, code, 'Sam');
      const [duet] = await db
        .select({ premise: duets.premise })
        .from(duets)
        .where(eq(duets.id, duetId));
      premises.add(duet.premise);
    }
    expect(premises.size).toBe(3);
  });
});

describe('limits', () => {
  it(`keeps ${MAX_OPEN_INVITES} open at once`, async () => {
    const maya = await newUser('maya');
    for (let i = 0; i < MAX_OPEN_INVITES; i += 1) await createInvite(maya, 'Maya');
    await expect(createInvite(maya, 'Maya')).rejects.toBeInstanceOf(RateLimitError);
  });

  it(`makes ${MAX_INVITES_PER_DAY} a day, open or not`, async () => {
    const maya = await newUser('maya');
    const now = new Date();
    await db.insert(invites).values(
      Array.from({ length: MAX_INVITES_PER_DAY }, (_, i) => ({
        code: `TEST${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`,
        inviterUserId: maya,
        inviterName: 'Maya',
        expiresAt: new Date(now.getTime() + 1000),
        acceptedAt: now,
        createdAt: now,
      }))
    );
    await expect(createInvite(maya, 'Maya')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('on the desk', () => {
  it("is each player's next story, names the other, and links its side once started", async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const { code } = await createInvite(maya, 'Maya');
    const { duetId } = await acceptInvite(sam, code, 'Sam');

    for (const [player, partner] of [
      [maya, 'Sam'],
      [sam, 'Maya'],
    ] as const) {
      const ended = await finishAStory(player);
      const next = await nextStoryFor(player, ended);
      expect(next).toMatchObject({
        origin: 'duet',
        withPartner: partner,
        fromPool: false,
        fromChatGPT: false,
      });

      const { sessionId } = await startNextStory(player, ended, { how: 'begin_now' });
      const session = await sessions.getSession(player, sessionId);
      const [line] = await db
        .select()
        .from(storylines)
        .where(eq(storylines.id, session.storylineId));
      expect(line.duetId).toBe(duetId);
    }

    const [duet] = await db.select().from(duets).where(eq(duets.id, duetId));
    expect(duet.sideAStorylineId).not.toBeNull();
    expect(duet.sideBStorylineId).not.toBeNull();
    const [samInMayas] = await db
      .select({ name: persons.name })
      .from(characters)
      .innerJoin(persons, eq(persons.id, characters.personId))
      .where(eq(characters.id, duet.sideAPartnerCharacterId!));
    expect(samInMayas.name).toBe('Sam');
  });

  it('is never offered to anyone else', async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const ana = await newUser('ana');
    const { code } = await createInvite(maya, 'Maya');
    await acceptInvite(sam, code, 'Sam');
    const ended = await finishAStory(ana);
    const next = await nextStoryFor(ana, ended);
    expect(next?.origin).not.toBe('duet');
  });
});

describe('when a player leaves', () => {
  it('renames them on the other side, and leaves nothing of their name there', async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const { code } = await createInvite(maya, 'Maya');
    const { duetId } = await acceptInvite(sam, code, 'Sam');
    const ended = await finishAStory(maya);
    await startNextStory(maya, ended, { how: 'begin_now' });

    await purgeUsersByEmail('sam@invites.local');

    const [duet] = await db.select().from(duets).where(eq(duets.id, duetId));
    expect(duet.sideBUserId).toBeNull();
    expect(duet.sideBName).not.toBe('Sam');
    const [renamed] = await db
      .select({ name: persons.name })
      .from(characters)
      .innerJoin(persons, eq(persons.id, characters.personId))
      .where(eq(characters.id, duet.sideAPartnerCharacterId!));
    expect(renamed.name).toBe(duet.sideBName);

    const text = JSON.stringify(
      await db.select().from(events).where(eq(events.storylineId, duet.sideAStorylineId!))
    );
    expect(text).not.toMatch(/\bSam\b/);
    expect(
      await db
        .select()
        .from(storyTemplates)
        .where(and(eq(storyTemplates.duetId, duetId), inArray(storyTemplates.userId, [sam])))
    ).toHaveLength(0);
  });

  it("renames them in the other side's template when that side hasn't started", async () => {
    const maya = await newUser('maya');
    const sam = await newUser('sam');
    const { code } = await createInvite(maya, 'Maya');
    const { duetId } = await acceptInvite(sam, code, 'Sam');

    await purgeUsersByEmail('sam@invites.local');

    const [side] = await db.select().from(storyTemplates).where(eq(storyTemplates.duetId, duetId));
    expect(side.userId).toBe(maya);
    expect(JSON.stringify(side.content)).not.toMatch(/\bSam\b/);
  });
});
