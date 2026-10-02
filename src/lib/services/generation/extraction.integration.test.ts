import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { extractionPrompt } from '@/lib/ai/prompts/extraction.prompt';
import * as persons from '../persons/persons.service';
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

  // occurredAt is when a beat happened; narrativeOrder is the order it is told
  // in. They are deliberately different columns, and with every beat dateless a
  // timeline cannot tell three weeks of silence from ten minutes.
  it('dates each beat from the messages it covers', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const events = await db.query.events.findMany({
      where: { storylineId: storyline.id },
      orderBy: { narrativeOrder: 'asc' },
    });

    const dated = events.filter((e) => e.occurredAt !== null);
    expect(dated.length).toBeGreaterThan(0);
    for (const event of dated) expect(event.occurredAt).toBeInstanceOf(Date);
  });

  // A model can return anything in a string field. An unparseable date must not
  // reach the column as an Invalid Date, which Postgres rejects — that would
  // lose a whole extraction over one bad value.
  it('drops an unparseable date rather than failing the extraction', async () => {
    fake.register(extractionPrompt, ({ vars }) => ({
      title: 'Bad Dates',
      tone: 'confused',
      setting: null,
      arcSummary: 'Something happened at some point.',
      cast: [
        {
          name: vars.user.self?.name ?? 'Blossom',
          existingPersonId: vars.user.self?.id ?? null,
          sourceHandle: null,
          role: 'protagonist' as const,
          description: null,
          voiceTone: null,
          want: 'to know when this actually happened',
          avoids: null,
        },
      ],
      relationships: [],
      beats: [
        {
          title: 'Whenever this was',
          description: 'x',
          stakes: null,
          occurredAt: 'the third of never',
          participantNames: [],
          engagementScore: 5,
        },
      ],
      background: [],
      motifs: [],
    }));

    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const [event] = await db.query.events.findMany({ where: { storylineId: storyline.id } });
    expect(event.occurredAt).toBeNull();
    expect(storyline.status).toBe('ready');
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

/**
 * A person outlives the storyline that introduced them, so a gap in their row
 * outlives it too.
 *
 * Andi was created before extraction captured voices and still had none days
 * later, across three storylines, because every later extraction matched her
 * existing row and returned it before the voice it had just worked out could be
 * used. The turn prompt renders voice notes, so she reached the model with
 * nothing saying how she speaks.
 */
describe('voice repair on a person who already exists', () => {
  it('fills a missing voice, and refuses to overwrite one that is there', async () => {
    const handle = `+1555010${Math.floor(Math.random() * 9000) + 1000}`;

    // Created the way a pre-fix row was: no voice at all.
    const first = await persons.getOrCreatePersonByHandle(userId, handle, 'Andi');
    expect(first.voiceProfile).toBeNull();

    // A later extraction sees her again and has worked out how she speaks.
    const repaired = await persons.getOrCreatePersonByHandle(userId, handle, 'Andi', {
      tone: 'dry and organised',
    });
    expect(repaired.id).toBe(first.id);
    expect(repaired.voiceProfile).toStrictEqual({ tone: 'dry and organised' });

    // A third extraction reads her differently. The first reading stands: a
    // person's voice must not be decided by whichever thread was imported last.
    const again = await persons.getOrCreatePersonByHandle(userId, handle, 'Andi', {
      tone: 'completely different',
    });
    expect(again.id).toBe(first.id);
    expect(again.voiceProfile).toStrictEqual({ tone: 'dry and organised' });
  });
});

/**
 * Every character gets something to pursue, including the quiet ones.
 *
 * `want` is required rather than nullable on purpose: every nullable field in
 * this schema gets nulled for the person who barely speaks in a group chat, and
 * that is precisely the character who then never acts. A character with no want
 * can only respond to whoever spoke last.
 */
describe('character wants', () => {
  it('gives every cast member a want', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const cast = await db.query.characters.findMany({ where: { storylineId: storyline.id } });

    expect(cast.length).toBeGreaterThan(1);
    for (const character of cast) {
      expect(character.want).toBeTruthy();
    }
  });

  // Per storyline, not per person: the same human wants different things in
  // different stories, which is why characters and persons are separate tables.
  it('keeps the want on the character rather than the person', async () => {
    const storyline = await extractStoryline(userId, unsentApology, { generator: fake });

    const [character] = await db.query.characters.findMany({
      where: { storylineId: storyline.id },
      with: { person: true },
    });

    expect(character.want).toBeTruthy();
    expect(character.person).not.toHaveProperty('want');
  });
});

/**
 * Who a person *is*, across conversations.
 *
 * The bug this fixes merged two humans into one `persons` row: `sourceHandle` is
 * described to the model as "the exact name this person sent messages under", so
 * it returns a display name — and hashing that made a Lauren and an Ollie, each
 * labelled "Person A" in a separate conversation, the same person. Nothing
 * errors. Both rows read as valid, and the two then share a voice, a
 * relationship history and every storyline either appears in.
 *
 * Identity is now the transcript's handle, which the client sends as a stable
 * per-person pseudonym. The name is only a key into the transcript.
 */
describe('person identity across conversations', () => {
  /** A transcript whose only other speaker has a given name and handle. */
  const conversationWith = (sender: string, handle: string, surface = 'imessage') => ({
    surface,
    messages: Array.from({ length: 60 }, (_, i) => ({
      isFromMe: i % 2 === 0,
      handle: i % 2 === 0 ? 'me' : handle,
      sender: i % 2 === 0 ? 'me' : sender,
      text: `message ${i}`,
      sentAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
    })),
  });

  /** Makes the fake name the other speaker exactly as the transcript does. */
  function castAs(sender: string, existingPersonId: string | null = null) {
    fake.register(extractionPrompt, ({ vars }) => ({
      title: 'A Story',
      tone: 'plain',
      setting: null,
      arcSummary: 'Something happened.',
      cast: [
        {
          name: vars.user.self?.name ?? 'Blossom',
          existingPersonId: vars.user.self?.id ?? null,
          sourceHandle: null,
          role: 'protagonist' as const,
          description: null,
          voiceTone: null,
          want: 'to be understood',
          avoids: null,
        },
        {
          name: sender,
          existingPersonId,
          // What the model actually returns: the display name, not the handle.
          sourceHandle: sender,
          role: 'supporting' as const,
          description: null,
          voiceTone: null,
          want: 'to be left alone',
          avoids: null,
        },
      ],
      relationships: [],
      beats: [
        {
          title: 'One',
          description: 'x',
          stakes: null,
          occurredAt: null,
          participantNames: [vars.user.self?.name ?? 'Blossom', sender],
          engagementScore: 5,
        },
      ],
      background: [],
      motifs: [],
    }));
  }

  const castNames = async (storylineId: string) => {
    const full = await db.query.storylines.findFirst({
      where: { id: storylineId },
      with: { characters: { with: { person: true } } },
    });
    return full!.characters.map((c) => c.person);
  };

  /**
   * (a) The Lauren/Ollie regression. Two conversations, each with a "Person A",
   * different handles — two people.
   */
  it('keeps two people apart when a transcript labels them the same', async () => {
    castAs('Person A');
    const lauren = await extractStoryline(
      userId,
      conversationWith('Person A', 'c_1111111111111111'),
      { generator: fake }
    );
    castAs('Person A');
    const ollie = await extractStoryline(
      userId,
      conversationWith('Person A', 'c_2222222222222222'),
      { generator: fake }
    );

    const all = await persons.listPersons(userId);
    const others = all.filter((p) => !p.isSelf);
    expect(others).toHaveLength(2);

    // And each storyline is cast with its own, not with the first one twice.
    const first = (await castNames(lauren.id)).find((p) => !p.isSelf)!;
    const second = (await castNames(ollie.id)).find((p) => !p.isSelf)!;
    expect(second.id).not.toBe(first.id);
  });

  /** (b) The other half: one handle under two names is still one person. */
  it('keeps one person when the same handle appears under different names', async () => {
    castAs('Lauren');
    await extractStoryline(userId, conversationWith('Lauren', 'c_3333333333333333'), {
      generator: fake,
    });
    castAs('Lo');
    const second = await extractStoryline(userId, conversationWith('Lo', 'c_3333333333333333'), {
      generator: fake,
    });

    const others = (await persons.listPersons(userId)).filter((p) => !p.isSelf);
    expect(others).toHaveLength(1);
    expect((await castNames(second.id)).find((p) => !p.isSelf)!.id).toBe(others[0].id);
  });

  /**
   * (c) The handle is a fact and `existingPersonId` is the model's opinion. When
   * they disagree the handle wins, because a misrecognition must not be able to
   * merge two humans.
   */
  it('ignores a recognition that contradicts the handle', async () => {
    castAs('Lauren');
    const first = await extractStoryline(userId, conversationWith('Lauren', 'c_4444444444444444'), {
      generator: fake,
    });
    const lauren = (await castNames(first.id)).find((p) => !p.isSelf)!;

    // The model insists this is Lauren. The handle says otherwise.
    castAs('Ollie', lauren.id);
    const second = await extractStoryline(userId, conversationWith('Ollie', 'c_5555555555555555'), {
      generator: fake,
    });

    const ollie = (await castNames(second.id)).find((p) => !p.isSelf)!;
    expect(ollie.id).not.toBe(lauren.id);
    expect((await persons.listPersons(userId)).filter((p) => !p.isSelf)).toHaveLength(2);
  });

  /**
   * (d) Someone previously only mentioned, now heard from. They have a row and
   * no handle, so this is the moment it earns one — better than a second row for
   * a person the model correctly recognised.
   */
  it('gives a mentioned-only person their handle the first time they speak', async () => {
    const mentioned = await persons.createPerson(userId, { name: 'Ollie' });

    castAs('Ollie', mentioned.id);
    const storyline = await extractStoryline(
      userId,
      conversationWith('Ollie', 'c_6666666666666666'),
      { generator: fake }
    );

    const cast = (await castNames(storyline.id)).find((p) => !p.isSelf)!;
    expect(cast.id).toBe(mentioned.id);
    expect((await persons.listPersons(userId)).filter((p) => !p.isSelf)).toHaveLength(1);

    // And they are now findable by that handle, which is the point of claiming it.
    castAs('Ollie');
    const again = await extractStoryline(userId, conversationWith('Ollie', 'c_6666666666666666'), {
      generator: fake,
    });
    expect((await castNames(again.id)).find((p) => !p.isSelf)!.id).toBe(mentioned.id);
  });

  /**
   * The handle check has to come *first*, not merely exist. Someone already known
   * by their handle speaks again, and the model points `existingPersonId` at a
   * different person who has no handle yet. Resolving by recognition would claim
   * that unrelated row for this handle — giving one human's pseudonym to another
   * person's record, which is the merge in reverse.
   */
  it('matches on the handle before considering who the model recognised', async () => {
    castAs('Lauren');
    const first = await extractStoryline(userId, conversationWith('Lauren', 'c_8888888888888888'), {
      generator: fake,
    });
    const lauren = (await castNames(first.id)).find((p) => !p.isSelf)!;

    // Someone mentioned in passing, with no handle of their own.
    const mentionedOnly = await persons.createPerson(userId, { name: 'Lo' });

    // Lauren speaks again under her own handle; the model misrecognises her as Lo.
    castAs('Lauren', mentionedOnly.id);
    const second = await extractStoryline(
      userId,
      conversationWith('Lauren', 'c_8888888888888888'),
      { generator: fake }
    );

    expect((await castNames(second.id)).find((p) => !p.isSelf)!.id).toBe(lauren.id);

    // And Lo is untouched — still mentioned-only, not wearing Lauren's identity.
    const lo = (await persons.listPersons(userId)).find((p) => p.id === mentionedOnly.id)!;
    expect(lo.name).toBe('Lo');
    expect((await persons.listPersons(userId)).filter((p) => !p.isSelf)).toHaveLength(2);
  });

  /**
   * (e) The dev lab imports CSVs where `handle` is a placeholder. Hashing those
   * would make every CSV-imported contact the same person.
   */
  it('never matches on a placeholder handle', async () => {
    castAs('Lauren');
    await extractStoryline(userId, conversationWith('Lauren', 'them'), { generator: fake });
    castAs('Ollie');
    await extractStoryline(userId, conversationWith('Ollie', 'them'), { generator: fake });

    const others = (await persons.listPersons(userId)).filter((p) => !p.isSelf);
    expect(others).toHaveLength(2);
    expect(others.map((p) => p.name).sort()).toStrictEqual(['Lauren', 'Ollie']);
  });

  /**
   * (f) A group thread where every message carries the thread's own id. Keying
   * on that would give every participant the same hash and collapse the cast.
   */
  it('never merges a group chat that shares one handle', async () => {
    const shared = 'c_7777777777777777';
    const group = {
      surface: 'imessage',
      messages: Array.from({ length: 60 }, (_, i) => ({
        isFromMe: i % 3 === 0,
        handle: i % 3 === 0 ? 'me' : shared,
        sender: i % 3 === 0 ? 'me' : i % 3 === 1 ? 'Lauren' : 'Ollie',
        text: `message ${i}`,
        sentAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
      })),
    };

    fake.register(extractionPrompt, ({ vars }) => ({
      title: 'Three Of Us',
      tone: 'plain',
      setting: null,
      arcSummary: 'Something happened.',
      cast: [
        {
          name: vars.user.self?.name ?? 'Blossom',
          existingPersonId: vars.user.self?.id ?? null,
          sourceHandle: null,
          role: 'protagonist' as const,
          description: null,
          voiceTone: null,
          want: 'w',
          avoids: null,
        },
        ...['Lauren', 'Ollie'].map((name) => ({
          name,
          existingPersonId: null,
          sourceHandle: name,
          role: 'supporting' as const,
          description: null,
          voiceTone: null,
          want: 'w',
          avoids: null,
        })),
      ],
      relationships: [],
      beats: [
        {
          title: 'One',
          description: 'x',
          stakes: null,
          occurredAt: null,
          participantNames: ['Lauren', 'Ollie'],
          engagementScore: 5,
        },
      ],
      background: [],
      motifs: [],
    }));

    const storyline = await extractStoryline(userId, group, { generator: fake });

    const cast = (await castNames(storyline.id)).filter((p) => !p.isSelf);
    expect(cast).toHaveLength(2);
    expect(new Set(cast.map((p) => p.id)).size).toBe(2);
  });
});
