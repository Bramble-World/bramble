import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '@/index';
import { events as eventsTable, storylines as storylineTable, users } from '@/db/schema/tables';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import { getWorld, weightsFor } from './world.service';
import { MAX_WORLD_EVENTS } from './world.types';

/**
 * The moments a reader can start playing from.
 *
 * Replaces the people-graph suite this file used to hold; the graph was retired
 * when the client stopped drawing it. The one test carried over verbatim is that
 * an empty world is a 200 and an invitation, because "empty becomes 404" is the
 * easiest mistake to make here and the screen depends on it.
 *
 * Cleanup is by prefix, not exact id: several tests create a second user, and one
 * failing before its own cleanup would otherwise make the *next* run fail for a
 * different reason — which is how a real defect gets mistaken for a flake.
 */
const CLERK = 'user_world_owner';

let userId: string;
let storylineId: string;
let selfId: string;
let otherId: string;
let castA: string;
let castB: string;

/** Appends an extracted beat with a known score. */
async function beat(
  title: string,
  engagementScore: number | undefined,
  storyline = storylineId,
  participantCharacterIds: string[] = [castA, castB]
) {
  return timeline.appendEvent(userId, storyline, {
    origin: 'extracted',
    title,
    description: `what happened at ${title}`,
    participantCharacterIds,
    engagementScore,
  });
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
    .values({ clerkId: CLERK, email: 'owner@world.local' })
    .returning({ id: users.id });
  userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'A World',
    sourceSurface: 'imessage',
  });
  storylineId = storyline.id;
  await storylines.markStatus(userId, storylineId, 'ready');

  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  const other = await persons.createPerson(userId, { name: 'Maya' });
  selfId = self.id;
  otherId = other.id;

  const a = await storylines.castCharacter(userId, storylineId, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storylineId, other.id);
  castA = a.id;
  castB = b.id;
});

describe('getWorld', () => {
  /**
   * "Not enough context yet" is an invitation, not a failure. A 404 here would
   * make the client render an error where it should render that.
   */
  it('gives a reader with nothing an empty world, not an error', async () => {
    const [empty] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_empty`, email: 'empty@world.local' })
      .returning({ id: users.id });

    const world = await getWorld(empty.id);

    expect(world.events).toStrictEqual([]);
    expect(world.truncated).toBe(false);

    await db.delete(users).where(eq(users.id, empty.id));
  });

  it('returns the highest-scoring beats first', async () => {
    await beat('quiet logistics', 2);
    await beat('the confrontation', 9);
    await beat('something shifts', 5);

    const world = await getWorld(userId);

    expect(world.events.map((e) => e.title)).toStrictEqual([
      'the confrontation',
      'something shifts',
      'quiet logistics',
    ]);
    expect(world.events.map((e) => e.score)).toStrictEqual([9, 5, 2]);
  });

  /**
   * Null means nobody asked the model, which is not the same claim as "the model
   * judged this dull". Ranking it last would assert the second while only knowing
   * the first, so it is excluded instead.
   */
  /**
   * The card the client draws shows a title, a date, a paragraph and the people
   * who were there — so all four have to arrive with the ranking, in one request.
   */
  it('carries what the card renders: description and who was there', async () => {
    await beat('the confrontation', 9);

    const [event] = (await getWorld(userId)).events;

    expect(event.description).toBe('what happened at the confrontation');
    expect(event.people.map((p) => p.name)).toStrictEqual(['Blossom', 'Maya']);
    expect(event.people[0].isSelf).toBe(true);
  });

  /**
   * People, not characters. A `characters` row is one storyline's casting, so
   * returning those would put the same human on the screen once per storyline and
   * give the client no way to tell it was one person.
   */
  it('names each person once, however many storylines they are cast in', async () => {
    const second = await storylines.createStoryline(userId, {
      title: 'Another Arc',
      sourceSurface: 'imessage',
    });
    await storylines.markStatus(userId, second.id, 'ready');
    const c = await storylines.castCharacter(userId, second.id, selfId, { role: 'protagonist' });
    const d = await storylines.castCharacter(userId, second.id, otherId);

    await beat('here', 9);
    await beat('and here', 8, second.id, [c.id, d.id]);

    const world = await getWorld(userId);
    const ids = world.events.flatMap((e) => e.people.map((p) => p.id));

    // Maya is cast twice, as two characters — and is one person on the screen.
    expect(new Set(ids).size).toBe(2);
    for (const event of world.events) {
      expect(event.people.map((p) => p.id)).toStrictEqual([selfId, otherId]);
    }
  });

  /**
   * The reader comes first whatever they are called. Seeded with a name that
   * sorts *ahead* of theirs, because with "Blossom" and "Maya" alone an
   * alphabetical sort produces the same answer and the rule goes untested.
   */
  it('puts the reader first even when another name sorts above theirs', async () => {
    const aaron = await persons.createPerson(userId, { name: 'Aaron' });
    const castC = await storylines.castCharacter(userId, storylineId, aaron.id);

    await beat('all three', 9, storylineId, [castA, castB, castC.id]);

    const [event] = (await getWorld(userId)).events;

    expect(event.people.map((p) => p.name)).toStrictEqual(['Blossom', 'Aaron', 'Maya']);
  });

  it('gives a beat with nobody recorded an empty cast rather than dropping it', async () => {
    await beat('nobody was there', 7, storylineId, []);

    const [event] = (await getWorld(userId)).events;

    expect(event.title).toBe('nobody was there');
    expect(event.people).toStrictEqual([]);
  });

  it('never offers a beat nobody scored', async () => {
    await beat('scored', 4);
    await beat('never scored', undefined);

    const world = await getWorld(userId);

    expect(world.events.map((e) => e.title)).toStrictEqual(['scored']);
  });

  /**
   * Only the imported conversation is an entry point. Starting "from" a beat the
   * reader's own choice caused is incoherent, and generated beats are most of what
   * would make this list hundreds long.
   */
  it('never offers a beat the reader caused', async () => {
    await beat('from the conversation', 6);

    const session = await sessions.startSession(userId, storylineId);
    const turn = await sessions.openTurn(userId, session.id, 'something happened', [
      { label: 'a' },
      { label: 'b' },
    ]);
    await timeline.appendEvent(userId, storylineId, {
      origin: 'conversation_generated',
      triggeredByTurnId: turn.id,
      generationRationale: 'because the reader chose it',
      title: 'a beat they caused',
      description: 'x',
      participantCharacterIds: [],
      // Scored, so only the origin predicate can be excluding it.
      engagementScore: 10,
    });

    const world = await getWorld(userId);

    expect(world.events.map((e) => e.title)).toStrictEqual(['from the conversation']);
  });

  it('ranks across every storyline the reader owns', async () => {
    const second = await storylines.createStoryline(userId, {
      title: 'Another Arc',
      sourceSurface: 'imessage',
    });
    await storylines.markStatus(userId, second.id, 'ready');
    const c = await storylines.castCharacter(userId, second.id, selfId, { role: 'protagonist' });
    const d = await storylines.castCharacter(userId, second.id, otherId);

    await beat('from the first', 4);
    await timeline.appendEvent(userId, second.id, {
      origin: 'extracted',
      title: 'from the second',
      description: 'x',
      participantCharacterIds: [c.id, d.id],
      engagementScore: 8,
    });

    const world = await getWorld(userId);

    expect(world.events.map((e) => e.title)).toStrictEqual(['from the second', 'from the first']);
    // Each beat says which story it belongs to, or twenty titles are orphans.
    expect(world.events.map((e) => e.storylineTitle)).toStrictEqual(['Another Arc', 'A World']);
  });

  it(`caps at ${MAX_WORLD_EVENTS} and says so`, async () => {
    for (let i = 0; i < MAX_WORLD_EVENTS + 3; i++) {
      await beat(`beat ${i}`, (i % 10) + 1);
    }

    const world = await getWorld(userId);

    expect(world.events).toHaveLength(MAX_WORLD_EVENTS);
    expect(world.truncated).toBe(true);
  });

  /**
   * Seeded past the ceiling on purpose. With fewer scored beats than the cap, an
   * unclamped limit returns the same rows as a clamped one and the assertion proves
   * nothing — the clamp has to be able to bite before a test can see it.
   */
  it('honours a smaller limit, and clamps a larger one to the ceiling', async () => {
    for (let i = 0; i < MAX_WORLD_EVENTS + 5; i++) await beat(`beat ${i}`, (i % 10) + 1);

    expect((await getWorld(userId, 3)).events).toHaveLength(3);
    // A client asking for a thousand gets the ceiling, not a thousand.
    expect((await getWorld(userId, 1000)).events).toHaveLength(MAX_WORLD_EVENTS);
    // And a nonsensical one still gets something renderable.
    expect((await getWorld(userId, 0)).events).toHaveLength(1);
    expect((await getWorld(userId, -5)).events).toHaveLength(1);
  });

  it('is not truncated when everything rankable fits', async () => {
    await beat('one', 5);
    await beat('two', 6);

    expect((await getWorld(userId)).truncated).toBe(false);
  });

  /**
   * The ordering has to be stable, because scores tie constantly on a ten-wide
   * scale — and a list that reshuffles between launches reads as a bug.
   */
  it('orders tied scores the same way every time', async () => {
    for (let i = 0; i < 5; i++) await beat(`tied ${i}`, 7);

    const first = (await getWorld(userId)).events.map((e) => e.eventId);
    const again = (await getWorld(userId)).events.map((e) => e.eventId);

    expect(again).toStrictEqual(first);
  });

  it('never shows one reader another reader world', async () => {
    await beat('mine', 9);

    const [other] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_other`, email: 'other@world.local' })
      .returning({ id: users.id });

    const world = await getWorld(other.id);

    expect(world.events).toStrictEqual([]);

    await db.delete(users).where(eq(users.id, other.id));
  });

  /**
   * `events` has no owner column — ownership runs through its storyline, with no
   * constraint relating the two. A row written directly against another reader's
   * storyline is the shape the join predicate exists to refuse.
   */
  it('counts only the reader own storylines when ranking', async () => {
    const [other] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_tenant`, email: 'tenant@world.local' })
      .returning({ id: users.id });

    const theirs = await storylines.createStoryline(other.id, {
      title: 'Theirs',
      sourceSurface: 'imessage',
    });
    await db.insert(eventsTable).values({
      storylineId: theirs.id,
      narrativeOrder: 1000,
      title: 'not yours to play',
      description: 'x',
      origin: 'extracted',
      engagementScore: 10,
    });

    await beat('mine', 3);

    const world = await getWorld(userId);

    expect(world.events.map((e) => e.title)).toStrictEqual(['mine']);
    expect(world.truncated).toBe(false);

    await db.delete(users).where(eq(users.id, other.id));
  });
});

describe('weightsFor', () => {
  it('normalises against the reader own best beat', async () => {
    await beat('low', 2);
    await beat('high', 8);

    const world = await getWorld(userId);
    const weights = weightsFor(world.events);

    expect(Math.max(...weights.values())).toBe(1);
    for (const w of weights.values()) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Per response, not against the 1-10 scale. A reader whose best beat scored a 6
   * should still get a legible spread rather than twenty muted dots, because the
   * client is signalling relative interest within one screen.
   */
  it('gives the best beat full weight even when it scored low', async () => {
    await beat('best of a quiet lot', 3);
    await beat('quieter', 1);

    const world = await getWorld(userId);
    const weights = weightsFor(world.events);

    expect(weights.get(world.events[0].eventId)).toBe(1);
  });

  it('is zero everywhere rather than dividing by zero', () => {
    const weights = weightsFor([
      {
        eventId: 'e1',
        storylineId: 's1',
        storylineTitle: 'A',
        title: 'x',
        occurredAt: null,
        score: 0,
      },
    ]);

    expect(weights.get('e1')).toBe(0);
  });
});

describe('what the rank query reads', () => {
  // Guards the partial index's predicates against drifting from the query's.
  it('matches the partial index predicates exactly', async () => {
    const [row] = await db
      .execute<{
        indexdef: string;
      }>(sql`select indexdef from pg_indexes where indexname = 'idx_events_engagement'`)
      .then((r) => r.rows);

    expect(row.indexdef).toContain('engagement_score IS NOT NULL');
    expect(row.indexdef).toContain("origin = 'extracted'");
  });

  it('leaves the storyline title joinable rather than denormalised', async () => {
    await beat('one', 5);
    await storylines.markStatus(userId, storylineId, 'ready');

    await db
      .update(storylineTable)
      .set({ title: 'Renamed After The Fact' })
      .where(eq(storylineTable.id, storylineId));

    const world = await getWorld(userId);

    expect(world.events[0].storylineTitle).toBe('Renamed After The Fact');
  });
});
