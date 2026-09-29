import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '@/index';
import { characters, users } from '@/db/schema/tables';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import { getWorld, weightsFor } from './world.service';

/**
 * The map of who is in a reader's stories.
 *
 * Raw SQL, so typecheck proves nothing about it — every assertion here is
 * against a real database.
 */
/**
 * Cleanup is by prefix, not by exact id: several tests here create a second
 * user, and a test that fails before its own cleanup would otherwise leave a row
 * that makes the *next* run fail for a different reason — which is how a real
 * defect gets mistaken for a flake.
 */
const CLERK = 'user_world_owner';
let userId: string;
let storylineId: string;
let selfId: string;
let otherId: string;

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
  const later = await persons.createPerson(userId, { name: 'Michael' });
  selfId = self.id;
  otherId = other.id;

  const a = await storylines.castCharacter(userId, storylineId, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storylineId, other.id);
  const c = await storylines.castCharacter(userId, storylineId, later.id);
  await persons.linkPersons(userId, self.id, other.id, 'oldest friend');

  // Three beats. Maya is in the first, Michael only in the third — so who has
  // been "met" depends entirely on how far the reader has got.
  await timeline.appendEvent(userId, storylineId, {
    origin: 'extracted',
    title: 'One',
    description: 'x',
    participantCharacterIds: [a.id, b.id],
  });
  await timeline.appendEvent(userId, storylineId, {
    origin: 'extracted',
    title: 'Two',
    description: 'x',
    participantCharacterIds: [a.id, b.id],
  });
  await timeline.appendEvent(userId, storylineId, {
    origin: 'extracted',
    title: 'Three',
    description: 'x',
    participantCharacterIds: [a.id, c.id],
  });
});

describe('getWorld', () => {
  /**
   * Screen 20 is "not enough context yet" — an invitation, not a failure. A 404
   * here would make the client render an error where it should render that.
   */
  it('gives a reader with nothing an empty world, not an error', async () => {
    const [empty] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_empty`, email: 'empty@world.local' })
      .returning({ id: users.id });

    const world = await getWorld(empty.id);

    expect(world.nodes).toStrictEqual([]);
    expect(world.edges).toStrictEqual([]);
    expect(world.truncated).toBe(false);

    await db.delete(users).where(eq(users.id, empty.id));
  });

  it('counts every beat as unexplored before the reader has played', async () => {
    const world = await getWorld(userId);
    const maya = world.nodes.find((n) => n.personId === otherId)!;

    expect(maya.unexploredBeats).toBe(3);
    expect(maya.storylineCount).toBe(1);
  });

  /**
   * Only extracted beats count — the same predicate `scriptExhausted` uses.
   *
   * Beats the reader caused are not story left to find. Counting them would mean
   * playing a story makes its node *grow*, which is the exact opposite of what
   * "bigger = more to explore" tells them.
   */
  it('does not count beats the reader caused as story left to explore', async () => {
    const before = (await getWorld(userId)).nodes.find(
      (n) => n.personId === otherId
    )!.unexploredBeats;

    const session = await sessions.startSession(userId, storylineId);
    const turn = await sessions.openTurn(userId, session.id, 'something happened', [
      { label: 'a' },
      { label: 'b' },
    ]);
    await timeline.appendEvent(userId, storylineId, {
      origin: 'conversation_generated',
      triggeredByTurnId: turn.id,
      generationRationale: 'because the reader chose it',
      title: 'A beat they caused',
      description: 'x',
      participantCharacterIds: [],
    });

    const after = (await getWorld(userId)).nodes.find(
      (n) => n.personId === otherId
    )!.unexploredBeats;

    // Strictly fewer — the playhead moved — and certainly not more.
    expect(after).toBeLessThan(before);
  });

  // The whole point of the weight: it has to shrink as the reader plays, or a
  // fully-explored person stays the biggest node on the map forever.
  it('shrinks as the playhead advances', async () => {
    const before = await getWorld(userId);
    const beforeMaya = before.nodes.find((n) => n.personId === otherId)!.unexploredBeats;

    await sessions.startSession(userId, storylineId);

    const after = await getWorld(userId);
    const afterMaya = after.nodes.find((n) => n.personId === otherId)!.unexploredBeats;

    expect(afterMaya).toBeLessThan(beforeMaya);
  });

  /**
   * Met is the same rule the prompt uses — appearing in a beat at or below the
   * playhead. Two definitions would let the map show someone the story has not
   * introduced, which is the leak the playhead exists to prevent.
   */
  it('has met only the people in beats the reader has reached', async () => {
    await sessions.startSession(userId, storylineId);
    const world = await getWorld(userId);

    const maya = world.nodes.find((n) => n.name === 'Maya')!;
    const michael = world.nodes.find((n) => n.name === 'Michael')!;

    expect(maya.met).toBe(true);
    expect(michael.met).toBe(false);
  });

  // Being present at your own story is not a fact about beats.
  it('always counts the reader as met', async () => {
    const world = await getWorld(userId);
    expect(world.nodes.find((n) => n.personId === selfId)!.met).toBe(true);
  });

  it('carries the structural relationship, and the edges between people', async () => {
    const world = await getWorld(userId);

    expect(world.nodes.find((n) => n.name === 'Maya')!.relationshipType).toBe('oldest friend');
    expect(world.edges).toHaveLength(1);
  });

  /**
   * The thickness of an edge. Without it every line on the map weighs the same,
   * which says nothing about which of these people actually appear together —
   * and a client that rendered a constant would look like a bug rather than a
   * fact.
   */
  it('counts the storylines the two ends of an edge share', async () => {
    const world = await getWorld(userId);
    expect(world.edges[0].sharedStorylines).toBe(1);

    // A second storyline both are cast in must move the number, or it is not
    // counting anything.
    const second = await storylines.createStoryline(userId, {
      title: 'Another',
      sourceSurface: 'imessage',
    });
    await storylines.markStatus(userId, second.id, 'ready');
    await storylines.castCharacter(userId, second.id, selfId, { role: 'protagonist' });
    await storylines.castCharacter(userId, second.id, otherId);

    const after = await getWorld(userId);
    expect(after.edges[0].sharedStorylines).toBe(2);
  });

  /**
   * The edge count is per reader.
   *
   * `characters` has no owner column and no constraint relating the owner of its
   * storyline to the owner of its person, so a row casting this reader's person
   * in someone else's storyline is writable and looks entirely valid afterwards
   * — invariants.md's category of silent failure. Written directly here because
   * no service will produce one, and the `s.user_id` predicate in the reader is
   * the only thing that stops it inflating this reader's map.
   */
  it('counts only the reader own storylines toward an edge', async () => {
    const [other] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_edges`, email: 'edges@world.local' })
      .returning({ id: users.id });

    const theirs = await storylines.createStoryline(other.id, {
      title: 'Theirs',
      sourceSurface: 'imessage',
    });
    await db.insert(characters).values([
      { storylineId: theirs.id, personId: selfId, role: 'protagonist' },
      { storylineId: theirs.id, personId: otherId },
    ]);

    const world = await getWorld(userId);
    expect(world.edges[0].sharedStorylines).toBe(1);

    await db.delete(users).where(eq(users.id, other.id));
  });

  it('never shows one reader another reader world', async () => {
    const [other] = await db
      .insert(users)
      .values({ clerkId: `${CLERK}_other`, email: 'other@world.local' })
      .returning({ id: users.id });

    const world = await getWorld(other.id);

    expect(world.nodes).toStrictEqual([]);

    await db.delete(users).where(eq(users.id, other.id));
  });
});

describe('weightsFor', () => {
  it('normalises against the reader own busiest node', async () => {
    const world = await getWorld(userId);
    const weights = weightsFor(world.nodes);

    expect(Math.max(...weights.values())).toBe(1);
    for (const w of weights.values()) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  // A reader who has explored everything must not divide by zero.
  it('is zero everywhere when nothing is left to explore', () => {
    const weights = weightsFor([
      {
        personId: 'p1',
        name: 'A',
        isSelf: false,
        relationshipType: null,
        unexploredBeats: 0,
        storylineCount: 1,
        met: true,
        lastActivityAt: null,
      },
    ]);

    expect(weights.get('p1')).toBe(0);
  });
});
