import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';

/**
 * Crossings, end to end against a real database and the fake model: what one
 * side does that the other's character would know opens the other side's next
 * beat as texts from that character, and nothing else crosses.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});

const { db } = await import('@/index');
const {
  duetCrossings,
  duets,
  persons,
  storylines,
  storyTemplates,
  users,
  storyTurns,
  turnSurfaces,
} = await import('@/db/schema/tables');
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');
const { duetConsequencePrompt } = await import('@/lib/ai/prompts/consequence.prompt');
const { SEED_STORIES } = await import('@/lib/pool/seeds');
const { advanceSession, commitChoice, generateConsequences } =
  await import('../generation/turns.service');
const sessions = await import('../sessions/sessions.service');
const { instantiateTemplate, startNextStory } = await import('../pool/next.service');
const { acceptInvite, createInvite } = await import('../invites/invites.service');
const { purgeUsersByEmail } = await import('../users/users.writer');
const { MAX_QUEUED_CROSSINGS, QUIET_AFTER_MS } = await import('./crossings.service');

const CLERK = 'user_crossings_';
const SEED_SLUG = 'crossings-test-seed';
const fake = createFakeGenerator();
registerFixtures(fake);
// One beat per decision, always, so each test controls what crosses: with
// `crossing` false the beat stays on its side.
let crossing = true;
fake.register(duetConsequencePrompt, () => ({
  events: [
    {
      title: 'Told them',
      description: 'The reader told them the plan.',
      stakes: null,
      participantCharacterIds: [],
      actorCharacterId: null,
      partnerKnows: crossing,
    },
  ],
  contextEntries: [],
  relationshipStates: [],
}));
let seedId: string;

async function newUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ clerkId: `${CLERK}${name}`, email: `${name}@crossings.local` })
    .returning({ id: users.id });
  await db.insert(persons).values({ userId: user.id, name: 'You', isSelf: true });
  return user.id;
}

/** Plays a seed story to its ending, so the next story is offered. */
async function finishAStory(userId: string) {
  const sessionId = await db.transaction((tx) =>
    instantiateTemplate(tx, userId, seedId, SEED_STORIES['close-friends'])
  );
  const session = await sessions.getSession(userId, sessionId);
  await db.update(storylines).set({ targetBeats: 6 }).where(eq(storylines.id, session.storylineId));
  const first = await advanceSession(userId, sessionId, { generator: fake });
  await commitChoice(userId, first.id, first.choices[0].id);
  await advanceSession(userId, sessionId, { generator: fake });
  return sessionId;
}

/** Starts this player's side of their story for two; returns its session. */
async function startSide(userId: string) {
  const ended = await finishAStory(userId);
  const { sessionId } = await startNextStory(userId, ended, { how: 'begin_now' });
  return sessionId;
}

/** A pair, sides made; `start` says whose sides are begun. */
async function pair(start: { maya?: boolean; sam?: boolean } = { maya: true, sam: true }) {
  const maya = await newUser('maya');
  const sam = await newUser('sam');
  const { code } = await createInvite(maya, 'Maya');
  const { duetId } = await acceptInvite(sam, code, 'Sam');
  const mayaSession = start.maya ? await startSide(maya) : null;
  const samSession = start.sam ? await startSide(sam) : null;
  return { maya, sam, duetId, mayaSession, samSession };
}

/** One choice on a side, and its consequences settled; `crosses` says whether it reaches the other. */
async function choose(userId: string, sessionId: string, crosses: boolean) {
  crossing = crosses;
  const turn = await advanceSession(userId, sessionId, { generator: fake });
  await commitChoice(userId, turn.id, turn.choices[0].id);
  await generateConsequences(userId, turn.id, { generator: fake });
  crossing = true;
  return turn;
}
const crosses = true;
const keepsQuiet = false;

const crossingsTo = (userId: string) =>
  db.select().from(duetCrossings).where(eq(duetCrossings.toUserId, userId));

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
  fake.calls.length = 0;
  crossing = true;
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  await db.delete(storyTemplates).where(eq(storyTemplates.slug, SEED_SLUG));
});

describe('a crossing', () => {
  it("opens the other side's next beat with texts from that player's character", async () => {
    const { maya, sam, duetId, mayaSession, samSession } = await pair();
    // Sam's side has a beat open already: the crossing waits for the next one.
    const samFirst = await advanceSession(sam, samSession!, { generator: fake });

    await choose(maya, mayaSession!, crosses);
    const [queued] = await crossingsTo(sam);
    expect(queued).toMatchObject({ status: 'queued', fromSide: 'a', title: 'Told them' });

    // The open beat is what Sam gets first; nothing crosses into it.
    expect((await advanceSession(sam, samSession!, { generator: fake })).id).toBe(samFirst.id);
    await commitChoice(sam, samFirst.id, samFirst.choices[0].id);

    const next = await advanceSession(sam, samSession!, { generator: fake });
    const [duet] = await db.select().from(duets).where(eq(duets.id, duetId));
    const mayaOnSams = duet.sideBPartnerCharacterId!;
    const [surface] = await db.select().from(turnSurfaces).where(eq(turnSurfaces.turnId, next.id));
    const texts = (surface.payload as { notifications: { characterId: string }[] }).notifications;
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => t.characterId === mayaOnSams)).toBe(true);
    const asked = fake.calls.filter((c) => c.promptName === 'turn.generate').at(-1)!;
    expect(asked.prompt).toContain('## What Maya just did');

    const [delivered] = await crossingsTo(sam);
    expect(delivered).toMatchObject({ status: 'delivered', deliveredTurnId: next.id });
  });

  it('is never made from what the reader keeps to themselves', async () => {
    const { maya, sam, mayaSession } = await pair();
    await choose(maya, mayaSession!, keepsQuiet);
    expect(await crossingsTo(sam)).toEqual([]);
  });

  it(`keeps at most ${MAX_QUEUED_CROSSINGS} waiting, the oldest dropped, and one per beat`, async () => {
    const { maya, sam, mayaSession } = await pair();
    for (let i = 0; i < MAX_QUEUED_CROSSINGS + 1; i += 1) await choose(maya, mayaSession!, crosses);
    const rows = await crossingsTo(sam);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(MAX_QUEUED_CROSSINGS);
    expect(rows.filter((r) => r.status === 'dropped')).toHaveLength(1);
  });

  it('stops for a side quiet more than 3 days', async () => {
    const { maya, sam, mayaSession, samSession } = await pair();
    const samTurn = await advanceSession(sam, samSession!, { generator: fake });
    await commitChoice(sam, samTurn.id, samTurn.choices[0].id);
    // Sam's last choice, and his side's start, 3 days and an hour ago.
    const old = new Date(Date.now() - QUIET_AFTER_MS - 60 * 60 * 1000);
    await db.update(storyTurns).set({ updatedAt: old }).where(eq(storyTurns.id, samTurn.id));
    await choose(maya, mayaSession!, crosses);
    expect(await crossingsTo(sam)).toEqual([]);
  });

  it('is held for a side not started yet, and its first beat opens with the newest', async () => {
    const { maya, sam, mayaSession } = await pair({ maya: true, sam: false });
    await choose(maya, mayaSession!, crosses);
    await choose(maya, mayaSession!, crosses);
    const held = await crossingsTo(sam);
    expect(held.every((r) => r.status === 'queued' && r.toStorylineId === null)).toBe(true);

    const samSession = await startSide(sam);
    const rows = await crossingsTo(sam);
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'dropped')).toHaveLength(held.length - 1);
    const first = await advanceSession(sam, samSession, { generator: fake });
    const [delivered] = (await crossingsTo(sam)).filter((r) => r.status === 'delivered');
    expect(delivered.deliveredTurnId).toBe(first.id);
  });

  it('goes with the player it came from, and stays as story text on the other side', async () => {
    const { maya, sam, duetId, mayaSession, samSession } = await pair();
    await choose(maya, mayaSession!, crosses);
    const delivered = await advanceSession(sam, samSession!, { generator: fake });
    await choose(maya, mayaSession!, crosses);

    await purgeUsersByEmail('maya@crossings.local');
    expect(
      await db
        .select()
        .from(duetCrossings)
        .where(and(eq(duetCrossings.duetId, duetId), eq(duetCrossings.fromSide, 'a')))
    ).toEqual([]);
    // The beat it became is still Sam's.
    const [still] = await db.select().from(storyTurns).where(eq(storyTurns.id, delivered.id));
    expect(still).toBeDefined();
  });
});
