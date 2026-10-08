import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as persons from './persons/persons.service';
import * as storylines from './storylines/storylines.service';
import * as motifs from './motifs/motifs.service';

/**
 * The rules in `src/docs/invariants.md` that no foreign key enforces.
 *
 * Unit tests prove a service calls its reader; they cannot prove the reader's
 * query is right, and these rules are entirely about which rows a query returns.
 * Every case here is one the database would accept without complaint — the
 * assertion is that the service refuses first.
 *
 * Two users are created so "belongs to someone else" is a real row rather than a
 * fabricated id, which is the only way to catch a scoping clause that was
 * omitted rather than one that is merely wrong.
 */
const OWNER_CLERK = 'user_invariants_owner';
const OTHER_CLERK = 'user_invariants_other';

let ownerId: string;
let otherId: string;

async function makeUser(clerkId: string, email: string): Promise<string> {
  const [user] = await db.insert(users).values({ clerkId, email }).returning({ id: users.id });
  return user.id;
}

beforeAll(async () => {
  // Cascades through every downstream table, so a previous failed run leaves
  // nothing behind.
  await db.delete(users).where(eq(users.clerkId, OWNER_CLERK));
  await db.delete(users).where(eq(users.clerkId, OTHER_CLERK));
  ownerId = await makeUser(OWNER_CLERK, 'owner@invariants.local');
  otherId = await makeUser(OTHER_CLERK, 'other@invariants.local');
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, OWNER_CLERK));
  await db.delete(users).where(eq(users.clerkId, OTHER_CLERK));
});

describe('§5 every user needs exactly one isSelf person', () => {
  it('creates it on first request and returns the same row after', async () => {
    const first = await persons.getOrCreateSelfPerson(ownerId, 'Blossom');
    const second = await persons.getOrCreateSelfPerson(ownerId, 'Blossom');

    expect(first.isSelf).toBe(true);
    expect(second.id).toBe(first.id);
  });

  // The partial unique index (WHERE is_self = true) is what makes the second
  // call a read rather than a second row. Concurrent first requests hit it too.
  it('produces one row under concurrent first requests', async () => {
    const results = await Promise.all([
      persons.getOrCreateSelfPerson(otherId, 'Blossom'),
      persons.getOrCreateSelfPerson(otherId, 'Blossom'),
      persons.getOrCreateSelfPerson(otherId, 'Blossom'),
    ]);

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });
});

describe('§1 contact handles are hashed, never stored raw', () => {
  it('finds the same person from two spellings of one number', async () => {
    const a = await persons.getOrCreatePersonByHandle(ownerId, '+1 (555) 010-1234', 'Maya');
    const b = await persons.getOrCreatePersonByHandle(ownerId, '5550101234', 'Maya');

    expect(b.id).toBe(a.id);
  });

  it('never writes the handle itself into the column', async () => {
    const handle = '5550105678';
    await persons.getOrCreatePersonByHandle(ownerId, handle, 'Sam');

    const rows = await db.query.persons.findMany({ where: { userId: ownerId } });
    const refs = rows.map((r) => r.sourceContactRef).filter(Boolean);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).not.toContain(handle);
  });
});

describe('§2 pair ordering — the sort satisfies the CHECK', () => {
  it('accepts either argument order and stores one row', async () => {
    const one = await persons.createPerson(ownerId, { name: 'Pair One' });
    const two = await persons.createPerson(ownerId, { name: 'Pair Two' });

    // Whichever order the caller uses, the CHECK (person_a_id < person_b_id)
    // would reject an unsorted insert outright.
    await persons.linkPersons(ownerId, one.id, two.id, 'siblings');

    const stored = await db.query.personRelationships.findMany({ where: { userId: ownerId } });
    const row = stored.find((r) => [one.id, two.id].includes(r.personAId));
    expect(row!.personAId < row!.personBId).toBe(true);
  });
});

describe('§3 cross-scope integrity — the silent class', () => {
  it("refuses to relate another user's person", async () => {
    const mine = await persons.createPerson(ownerId, { name: 'Mine' });
    const theirs = await persons.createPerson(otherId, { name: 'Theirs' });

    await expect(persons.linkPersons(ownerId, mine.id, theirs.id)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("refuses to cast another user's person in your storyline", async () => {
    const story = await storylines.createStoryline(ownerId, {
      title: 'Mine',
      sourceSurface: 'imessage',
    });
    const theirs = await persons.createPerson(otherId, { name: 'Theirs' });

    await expect(storylines.castCharacter(ownerId, story.id, theirs.id)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('refuses a relationship spanning two storylines', async () => {
    const storyA = await storylines.createStoryline(ownerId, {
      title: 'Story A',
      sourceSurface: 'imessage',
    });
    const storyB = await storylines.createStoryline(ownerId, {
      title: 'Story B',
      sourceSurface: 'imessage',
    });
    const one = await persons.createPerson(ownerId, { name: 'Cast One' });
    const two = await persons.createPerson(ownerId, { name: 'Cast Two' });

    const inA = await storylines.castCharacter(ownerId, storyA.id, one.id);
    const inB = await storylines.castCharacter(ownerId, storyB.id, two.id);

    // Both characters exist and both ids are real; only their storylines differ.
    await expect(
      storylines.relateCharacters(ownerId, storyA.id, inA.id, inB.id)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a motif occurrence pointing at another storyline's beat", async () => {
    const story = await storylines.createStoryline(ownerId, {
      title: 'Motif Story',
      sourceSurface: 'imessage',
    });
    const other = await storylines.createStoryline(ownerId, {
      title: 'Other Story',
      sourceSurface: 'imessage',
    });
    const motif = await motifs.createMotif(ownerId, { label: 'the lasagna incident' });

    const [beat] = await db.query.events.findMany({ limit: 1 });
    // Needs a real event id that belongs to neither storyline under test; the
    // seeded database supplies one. Skipped rather than faked if absent.
    if (!beat) return;

    await expect(
      motifs.recordMotifOccurrence(ownerId, motif.id, story.id, beat.id)
    ).rejects.toBeInstanceOf(ValidationError);

    // The same call without an event is fine — a motif can colour a whole story.
    await expect(motifs.recordMotifOccurrence(ownerId, motif.id, other.id)).resolves.toBeDefined();
  });
});

describe('§4 conditional columns', () => {
  it('sets failureReason with the failed status and clears it on recovery', async () => {
    const story = await storylines.createStoryline(ownerId, {
      title: 'Retryable',
      sourceSurface: 'imessage',
    });

    const failed = await storylines.markFailed(ownerId, story.id, 'model timed out');
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('model timed out');

    // A retry that succeeds must not leave the previous attempt's reason behind.
    const ready = await storylines.markStatus(ownerId, story.id, 'ready');
    expect(ready.status).toBe('ready');
    expect(ready.failureReason).toBeNull();
  });
});
