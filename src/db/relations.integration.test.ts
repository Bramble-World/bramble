import { describe, expect, it } from 'vitest';
import { db } from '../index';

/**
 * Relations are resolved when a query runs, not when the file compiles. A wrong
 * `alias`, a `from`/`to` pointing at the wrong column, or a relation whose
 * inverse was never declared all typecheck cleanly and all throw at query time —
 * so `pnpm typecheck` and `pnpm lint` would stay green while every nested read in
 * the app is broken.
 *
 * These tests run the graph. They need the seeded local database; CI builds one
 * in the Migrations job, which is why this runs there.
 */
describe('relational graph', () => {
  // Naming every relation of every table. If a relation is renamed or dropped
  // without this list changing, the query throws and the test fails.
  it('resolves every declared relation', async () => {
    const all = {
      users: () =>
        db.query.users.findFirst({
          with: {
            storylines: true,
            persons: true,
            motifs: true,
            personRelationships: true,
            sessions: true,
          },
        }),
      persons: () =>
        db.query.persons.findFirst({
          with: {
            user: true,
            characters: true,
            relationshipsAsA: true,
            relationshipsAsB: true,
            motifs: true,
          },
        }),
      personRelationships: () =>
        db.query.personRelationships.findFirst({
          with: { user: true, personA: true, personB: true },
        }),
      storylines: () =>
        db.query.storylines.findFirst({
          with: {
            user: true,
            characters: true,
            relationships: true,
            events: true,
            contextEntries: true,
            motifOccurrences: true,
            sessions: true,
            linksFrom: true,
            linksTo: true,
          },
        }),
      storylineLinks: () =>
        db.query.storylineLinks.findFirst({ with: { storylineA: true, storylineB: true } }),
      characters: () =>
        db.query.characters.findFirst({
          with: {
            storyline: true,
            person: true,
            relationshipsAsA: true,
            relationshipsAsB: true,
            contextEntries: true,
            events: true,
          },
        }),
      characterRelationships: () =>
        db.query.characterRelationships.findFirst({
          with: { storyline: true, characterA: true, characterB: true, states: true },
        }),
      relationshipStates: () =>
        db.query.relationshipStates.findFirst({ with: { relationship: true, event: true } }),
      events: () =>
        db.query.events.findFirst({
          with: {
            storyline: true,
            triggeredByTurn: true,
            participants: true,
            relationshipStates: true,
            motifOccurrences: true,
          },
        }),
      contextEntries: () =>
        db.query.contextEntries.findFirst({
          with: { storyline: true, character: true, triggeredByTurn: true },
        }),
      storylineSessions: () =>
        db.query.storylineSessions.findFirst({
          with: { storyline: true, user: true, turns: true },
        }),
      storyTurns: () =>
        db.query.storyTurns.findFirst({
          with: {
            session: true,
            choices: true,
            selectedChoice: true,
            triggeredEvents: true,
            triggeredContextEntries: true,
          },
        }),
      turnChoices: () => db.query.turnChoices.findFirst({ with: { turn: true } }),
      motifs: () =>
        db.query.motifs.findFirst({ with: { user: true, persons: true, occurrences: true } }),
      motifOccurrences: () =>
        db.query.motifOccurrences.findFirst({
          with: { motif: true, storyline: true, event: true },
        }),
    };

    for (const [table, query] of Object.entries(all)) {
      await expect(query(), `${table} relations`).resolves.toBeDefined();
    }
  });

  // `through` is the only place a relation crosses a table the caller never
  // names. If the junction columns were swapped, this still typechecks and
  // returns rows — just the wrong ones.
  it('traverses junctions with through, in both directions', async () => {
    const event = await db.query.events.findFirst({
      with: { participants: { with: { person: true } }, storyline: true },
    });
    expect(event!.participants.length).toBeGreaterThan(0);
    // A participant is a character in this event's own storyline, not any
    // character that happens to share a person.
    for (const c of event!.participants) {
      expect(c.storylineId).toBe(event!.storylineId);
      expect(c.person.id).toBe(c.personId);
    }

    // Asserted across every character, and asserted non-empty. Swapping the two
    // through() columns joins uuid to the wrong uuid, which matches nothing and
    // yields empty arrays — so a per-row loop alone would pass vacuously.
    const characters = await db.query.characters.findMany({ with: { events: true } });
    const traversed = characters.flatMap((c) => c.events.map((e) => [c, e] as const));
    expect(traversed.length).toBeGreaterThan(0);
    for (const [c, e] of traversed) expect(e.storylineId).toBe(c.storylineId);

    const motif = await db.query.motifs.findFirst({ with: { persons: true } });
    expect(motif!.persons.length).toBeGreaterThan(0);
  });

  // Pair tables join the same table twice. Without a matching alias on both
  // ends drizzle cannot tell which side is which, and picks one.
  it('resolves aliased pairs to the correct side', async () => {
    const link = await db.query.storylineLinks.findFirst({
      with: { storylineA: true, storylineB: true },
    });
    expect(link!.storylineA.id).toBe(link!.storylineAId);
    expect(link!.storylineB.id).toBe(link!.storylineBId);

    const rel = await db.query.characterRelationships.findFirst({
      with: { characterA: true, characterB: true },
    });
    expect(rel!.characterA.id).toBe(rel!.characterAId);
    expect(rel!.characterB.id).toBe(rel!.characterBId);

    const pr = await db.query.personRelationships.findFirst({
      with: { personA: true, personB: true },
    });
    expect(pr!.personA.id).toBe(pr!.personAId);
    expect(pr!.personB.id).toBe(pr!.personBId);

    // Every relationship a person appears in, from either column.
    const person = await db.query.persons.findFirst({
      where: { isSelf: true },
      with: { relationshipsAsA: true, relationshipsAsB: true },
    });
    for (const r of person!.relationshipsAsA) expect(r.personAId).toBe(person!.id);
    for (const r of person!.relationshipsAsB) expect(r.personBId).toBe(person!.id);
  });

  // storyTurns joins turnChoices twice: the options offered, and the one taken.
  // Crossing these would silently return a sibling turn's choices.
  it('separates offered choices from the selected choice', async () => {
    const turn = await db.query.storyTurns.findFirst({
      where: { selectedChoiceId: { isNotNull: true } },
      with: { choices: true, selectedChoice: true },
    });
    expect(turn!.choices.length).toBeGreaterThan(0);
    for (const c of turn!.choices) expect(c.turnId).toBe(turn!.id);
    expect(turn!.choices.map((c) => c.id)).toContain(turn!.selectedChoice!.id);
  });

  it('nests to the depth a reader needs', async () => {
    const storyline = await db.query.storylines.findFirst({
      with: {
        user: true,
        characters: { with: { person: true } },
        events: { with: { participants: true }, orderBy: { narrativeOrder: 'asc' } },
        sessions: { with: { turns: { with: { choices: true } } } },
      },
    });

    expect(storyline!.user.id).toBe(storyline!.userId);
    expect(storyline!.characters.length).toBeGreaterThan(0);

    const orders = storyline!.events.map((e) => e.narrativeOrder);
    expect(orders).toStrictEqual([...orders].sort((a, b) => a - b));
  });
});
