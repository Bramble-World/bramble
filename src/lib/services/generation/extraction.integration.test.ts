import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { extractionPrompt } from '@/lib/ai/prompts/extraction.prompt';
import { extractStoryline } from './extraction.service';
import { threeWeeksLater, unsentApology, verbatimTexts } from './__fixtures__/transcripts';

const CLERK = 'user_extraction_owner';
let userId: string;
let fake: FakeGenerator;

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@extraction.local' })
    .returning({ id: users.id });
  userId = user.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
});

beforeEach(async () => {
  // Each test starts from an empty account, since extraction's whole job is
  // creating things and reusing what it created before.
  await db.delete(users).where(eq(users.clerkId, CLERK));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@extraction.local' })
    .returning({ id: users.id });
  userId = user.id;

  fake = createFakeGenerator();
  registerFixtures(fake);
});

describe('extractStoryline', () => {
  it('produces a readable storyline with a timeline and a cast', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    expect(storyline.status).toBe('ready');
    expect(storyline.title).not.toBe('Untitled');

    const full = await db.query.storylines.findFirst({
      where: { id: storyline.id },
      with: { characters: { with: { person: true } }, events: true, contextEntries: true },
    });
    expect(full!.characters.length).toBeGreaterThan(1);
    expect(full!.events.length).toBeGreaterThan(0);
    for (const event of full!.events) expect(event.origin).toBe('extracted');
  });

  // invariants.md §1, and the reason this test exists at all: a breach looks
  // exactly like correct data, so nothing detects it except an explicit check.
  it('never writes a single message verbatim into any column', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const full = await db.query.storylines.findFirst({
      where: { id: storyline.id },
      with: {
        characters: { with: { person: true } },
        events: true,
        contextEntries: true,
        motifOccurrences: { with: { motif: true } },
      },
    });

    const persisted = JSON.stringify(full);
    for (const text of verbatimTexts(unsentApology)) {
      expect(persisted).not.toContain(text);
    }
  });

  // The account holder must be the one isSelf row, not a second person named
  // after them — otherwise the reader is a stranger in their own story and
  // continuity breaks for the person it matters most for.
  it('casts the account holder as their own isSelf person', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const full = await db.query.storylines.findFirst({
      where: { id: storyline.id },
      with: { characters: { with: { person: true } } },
    });
    const protagonist = full!.characters.find((c) => c.role === 'protagonist');

    expect(protagonist!.person.isSelf).toBe(true);
    const selves = await db.query.persons.findMany({ where: { userId, isSelf: true } });
    expect(selves).toHaveLength(1);
  });

  // The whole basis of cross-storyline continuity, and its failure is silent:
  // two persons rows for one human, with both individually valid.
  it('reuses the same person across two conversations with one handle', async () => {
    const first = await extractStoryline(userId, unsentApology, { generator: fake });
    const second = await extractStoryline(userId, threeWeeksLater, { generator: fake });

    const castOf = async (storylineId: string) =>
      (
        await db.query.characters.findMany({
          where: { storylineId },
          with: { person: true },
        })
      ).map((c) => c.person);

    const firstCast = await castOf(first.id);
    const secondCast = await castOf(second.id);

    const maya = firstCast.find((p) => !p.isSelf)!;
    const mayaAgain = secondCast.find((p) => !p.isSelf)!;
    expect(mayaAgain.id).toBe(maya.id);

    // And exactly two people exist in total: the reader and Maya.
    const all = await db.query.persons.findMany({ where: { userId } });
    expect(all).toHaveLength(2);
  });

  it('stores the contact reference hashed, never the handle', async () => {
    await extractStoryline(userId, unsentApology, { generator: fake });

    const people = await db.query.persons.findMany({ where: { userId } });
    const withRef = people.filter((p) => p.sourceContactRef);
    expect(withRef.length).toBeGreaterThan(0);

    for (const person of withRef) {
      expect(person.sourceContactRef).toMatch(/^[0-9a-f]{64}$/);
      expect(person.sourceContactRef).not.toContain('555');
    }
  });

  it('writes an arc summary, so the storyline is not stale the moment it exists', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    expect(storyline.arcSummary).not.toBeNull();
    expect(storyline.arcSummaryGeneratedAt).not.toBeNull();
  });

  it('numbers the timeline with gaps, leaving room for consequences', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const events = await db.query.events.findMany({
      where: { storylineId: storyline.id },
      orderBy: { narrativeOrder: 'asc' },
    });
    expect(events[0].narrativeOrder).toBe(1000);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].narrativeOrder - events[i - 1].narrativeOrder).toBe(1000);
    }
  });

  it('records relationships both structurally and for the story', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const structural = await db.query.personRelationships.findMany({ where: { userId } });
    const narrative = await db.query.characterRelationships.findMany({
      where: { storylineId: storyline.id },
    });

    expect(structural.length).toBeGreaterThan(0);
    expect(narrative.length).toBeGreaterThan(0);
    // Pair ordering is enforced by CHECK; this asserts the service sorted.
    for (const row of structural) expect(row.personAId < row.personBId).toBe(true);
    for (const row of narrative) expect(row.characterAId < row.characterBId).toBe(true);
  });

  // §4: failureReason is set exactly when status is failed. A storyline left in
  // `generating` forever would look like a job still running.
  it('marks the storyline failed with a reason when the model fails', async () => {
    fake.register(extractionPrompt, () => {
      throw new Error('model exploded');
    });

    await expect(extractStoryline(userId, unsentApology, { generator: fake })).rejects.toThrow(
      'model exploded'
    );

    const failed = await db.query.storylines.findMany({ where: { userId } });
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');
    expect(failed[0].failureReason).not.toBeNull();
  });
});
