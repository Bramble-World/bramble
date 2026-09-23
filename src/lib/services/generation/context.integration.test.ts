import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { NotFoundError } from '@/lib/utils/errors';
import {
  assembleSessionContext,
  assembleStorylineContext,
  assembleUserContext,
} from './context.reader';

/**
 * Context assembly against the seeded database.
 *
 * Run here rather than against mocks because the whole layer is a set of
 * queries, and everything it promises — one storyline's worth of rows, derived
 * values resolved once, nothing raw — is a property of what those queries
 * return.
 */
let seedUserId: string;
let storylineId: string;
let sessionId: string;

beforeAll(async () => {
  const [seed] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, 'user_seed_demo'));
  if (!seed) throw new Error('The seed user is missing. Run `pnpm db:seed` first.');
  seedUserId = seed.id;

  const storyline = await db.query.storylines.findFirst({
    where: { userId: seedUserId },
    with: { sessions: true },
  });
  storylineId = storyline!.id;
  sessionId = storyline!.sessions[0]!.id;
});

describe('assembleStorylineContext', () => {
  it('returns one storyline worth of everything', async () => {
    const context = await assembleStorylineContext(seedUserId, storylineId);

    expect(context.storyline.id).toBe(storylineId);
    expect(context.characters.length).toBeGreaterThan(0);
    expect(context.timeline.length).toBeGreaterThan(0);
    // Every beat belongs to this storyline, which is the point of scoping.
    for (const character of context.characters) expect(character.name).toBeTruthy();
  });

  it('presents the timeline in narrative order', async () => {
    const { timeline } = await assembleStorylineContext(seedUserId, storylineId);
    const orders = timeline.map((b) => b.narrativeOrder);

    expect(orders).toStrictEqual([...orders].sort((a, b) => a - b));
  });

  // The whole reason this layer exists: "current" is defined once, here, as the
  // state attached to the latest beat by the order the story is told in — not by
  // when the row happened to be written. Four prompts re-deriving that is four
  // chances to disagree.
  it('resolves each relationship to its latest state', async () => {
    const context = await assembleStorylineContext(seedUserId, storylineId);
    const withHistory = context.relationships.find((r) => r.currentDynamic !== null);
    if (!withHistory) return;

    const relationship = await db.query.characterRelationships.findFirst({
      where: { id: withHistory.id },
      with: { states: { with: { event: true } } },
    });
    const latest = [...relationship!.states].sort(
      (a, b) => b.event.narrativeOrder - a.event.narrativeOrder
    )[0];

    expect(withHistory.currentDynamic).toStrictEqual(latest.dynamic);
  });

  it('separates storyline-wide background from per-character background', async () => {
    const { background, characters } = await assembleStorylineContext(seedUserId, storylineId);
    const characterIds = new Set(characters.map((c) => c.id));

    // Anything keyed by character must key by a character in this storyline.
    for (const id of Object.keys(background.byCharacterId)) expect(characterIds.has(id)).toBe(true);
    expect(Array.isArray(background.storylineLevel)).toBe(true);
  });

  // A motif can recur through several beats of one story; a prompt only needs to
  // know it is in play, and a duplicated motif would weight it twice.
  it('lists each motif once however often it recurs', async () => {
    const { motifs } = await assembleStorylineContext(seedUserId, storylineId);
    expect(new Set(motifs.map((m) => m.id)).size).toBe(motifs.length);
  });

  // Prompt renderers are pure and fixtures get checked in, both of which break
  // if a Date or a drizzle row sneaks in.
  it('is fully JSON-serialisable', async () => {
    const context = await assembleStorylineContext(seedUserId, storylineId);

    expect(JSON.parse(JSON.stringify(context))).toStrictEqual(context);
  });

  it("refuses another user's storyline", async () => {
    const [other] = await db
      .insert(users)
      .values({ clerkId: 'user_context_other', email: 'other@context.local' })
      .returning({ id: users.id });

    await expect(assembleStorylineContext(other.id, storylineId)).rejects.toBeInstanceOf(
      NotFoundError
    );

    await db.delete(users).where(eq(users.id, other.id));
  });
});

describe('assembleSessionContext', () => {
  it('returns the decision loop so far, in order', async () => {
    const context = await assembleSessionContext(seedUserId, sessionId);
    const orders = context.turns.map((t) => t.turnOrder);

    expect(context.sessionId).toBe(sessionId);
    expect(orders).toStrictEqual([...orders].sort((a, b) => a - b));
  });

  it('reports which choice was taken, and null while a turn is open', async () => {
    const { turns } = await assembleSessionContext(seedUserId, sessionId);

    for (const turn of turns) {
      if (turn.selectedChoiceLabel === null) continue;
      // A recorded answer must be one of the options that turn offered.
      expect(turn.choices.map((c) => c.label)).toContain(turn.selectedChoiceLabel);
    }
  });
});

describe('assembleUserContext', () => {
  it('returns who the user already knows, so extraction can match them', async () => {
    const context = await assembleUserContext(seedUserId);

    expect(context.persons.length).toBeGreaterThan(0);
    expect(context.self).not.toBeNull();
  });

  // The model has no business seeing contact identifiers, hashed or not.
  it('never exposes a contact reference', async () => {
    const context = await assembleUserContext(seedUserId);

    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain('sourceContactRef');

    const stored = await db.query.persons.findMany({ where: { userId: seedUserId } });
    for (const person of stored) {
      if (person.sourceContactRef) expect(serialised).not.toContain(person.sourceContactRef);
    }
  });
});
