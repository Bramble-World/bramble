import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { ConflictError, ValidationError } from '@/lib/utils/errors';
import { createFakeGenerator, FakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import { consequencePrompt } from '@/lib/ai/prompts/consequence.prompt';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import { commitChoice, generateConsequences, generateTurn } from './turns.service';

/**
 * The decision loop, end to end, against the fake generator and a real database.
 *
 * The fake is the point: everything downstream of the model call is the real
 * thing — real context assembly, real transactions, real constraints — so what
 * these prove is the plumbing, which is what this PR is. Prompt quality is a
 * separate question and no test can answer it.
 */
const CLERK = 'user_turnloop_owner';
let userId: string;
let storylineId: string;
let fake: FakeGenerator;

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@turnloop.local' })
    .returning({ id: users.id });
  userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'The Unsent Apology',
    sourceSurface: 'imessage',
    tone: 'wistful',
  });
  storylineId = storyline.id;
  await storylines.markStatus(userId, storylineId, 'ready');

  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  const maya = await persons.createPerson(userId, { name: 'Maya' });
  const a = await storylines.castCharacter(userId, storylineId, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storylineId, maya.id);
  await storylines.relateCharacters(userId, storylineId, a.id, b.id, { closeness: 'was close' });

  await timeline.appendEvent(userId, storylineId, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in three weeks.',
    participantCharacterIds: [a.id, b.id],
  });
  await timeline.appendEvent(userId, storylineId, {
    origin: 'extracted',
    title: 'The message',
    description: 'One of them finally typed something.',
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, CLERK));
});

beforeEach(() => {
  fake = createFakeGenerator();
  registerFixtures(fake);
});

async function freshSession() {
  return sessions.startSession(userId, storylineId);
}

describe('generateTurn', () => {
  it('produces a beat with choices and persists it', async () => {
    const session = await freshSession();

    const turn = await generateTurn(userId, session.id, { generator: fake });

    expect(turn.narrativeContent.length).toBeGreaterThan(0);
    expect(turn.choices.length).toBeGreaterThanOrEqual(2);
    expect(turn.selectedChoiceId).toBeNull();
  });

  // The check is before the model call, not after: a session has at most one
  // open turn, so generating first would be paying for output to discard.
  it('returns the open turn without calling the model again', async () => {
    const session = await freshSession();

    const first = await generateTurn(userId, session.id, { generator: fake });
    const callsAfterFirst = fake.calls.length;
    const second = await generateTurn(userId, session.id, { generator: fake });

    expect(second.id).toBe(first.id);
    expect(fake.calls.length).toBe(callsAfterFirst);
  });

  it('gives the model the storyline and the loop so far', async () => {
    const session = await freshSession();

    await generateTurn(userId, session.id, { generator: fake });

    const call = fake.calls.at(-1)!;
    expect(call.promptName).toBe('turn.generate');
    expect(call.prompt).toContain('The Unsent Apology');
    expect(call.prompt).toContain('Where things stood');
    expect(call.prompt).toContain('Maya');
  });

  it('never puts a contact reference in front of the model', async () => {
    const session = await freshSession();
    await generateTurn(userId, session.id, { generator: fake });

    const stored = await db.query.persons.findMany({ where: { userId } });
    for (const person of stored) {
      if (person.sourceContactRef) {
        expect(fake.calls.at(-1)!.prompt).not.toContain(person.sourceContactRef);
      }
    }
  });
});

describe('commitChoice then generateConsequences', () => {
  it('records the answer without calling the model', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    const before = fake.calls.length;

    const answered = await commitChoice(userId, turn.id, turn.choices[0].id);

    expect(answered.selectedChoiceId).toBe(turn.choices[0].id);
    expect(answered.respondedAt).not.toBeNull();
    // The user is waiting on this half; a model call here would put a
    // multi-second wait inside their click.
    expect(fake.calls.length).toBe(before);
  });

  it('writes generated beats with lineage back to the decision', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    // Force the branch that changes canon, rather than depending on the seed.
    fake.register(consequencePrompt, ({ vars }) => ({
      events: [
        {
          title: 'A different answer',
          description: 'It was said out loud this time.',
          stakes: null,
          participantCharacterIds: vars.storyline.characters.map((c) => c.id),
          generationRationale: 'The reader chose directness where the original was evasive.',
        },
      ],
      contextEntries: [{ content: 'It had been building for months.', characterId: null }],
      relationshipStates: vars.storyline.relationships.length
        ? [
            {
              relationshipId: vars.storyline.relationships[0].id,
              closeness: 'closer',
              tension: null,
              powerBalance: null,
            },
          ]
        : [],
    }));

    const result = await generateConsequences(userId, turn.id, { generator: fake });
    expect(result.events).toBe(1);

    const generated = await db.query.events.findMany({ where: { triggeredByTurnId: turn.id } });
    expect(generated).toHaveLength(1);
    // invariants.md §4: a generated beat carries its lineage and its reasoning.
    expect(generated[0].origin).toBe('conversation_generated');
    expect(generated[0].generationRationale).not.toBeNull();

    // And it lands in the gap, not at the end — the whole point of gap numbering.
    const beats = await timeline.listTimeline(storylineId);
    const orders = beats.map((b) => b.narrativeOrder);
    expect(orders).toStrictEqual([...orders].sort((a, b) => a - b));
    expect(generated[0].narrativeOrder).toBeGreaterThan(orders[0]);
    expect(generated[0].narrativeOrder).toBeLessThan(orders[orders.length - 1] + 1);
  });

  // The lineage column is the idempotency key. A retry after a lost response must
  // not pay for a second generation or append a duplicate beat.
  it('is a no-op the second time, without calling the model', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    fake.register(consequencePrompt, () => ({
      events: [
        {
          title: 'Once only',
          description: 'x',
          stakes: null,
          participantCharacterIds: [],
          generationRationale: 'because',
        },
      ],
      contextEntries: [],
      relationshipStates: [],
    }));

    await generateConsequences(userId, turn.id, { generator: fake });
    const callsAfterFirst = fake.calls.length;
    const second = await generateConsequences(userId, turn.id, { generator: fake });

    expect(second.events).toBe(0);
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(await db.query.events.findMany({ where: { triggeredByTurnId: turn.id } })).toHaveLength(
      1
    );
  });

  it('accepts a decision that changes nothing', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    fake.register(consequencePrompt, () => ({
      events: [],
      contextEntries: [],
      relationshipStates: [],
    }));

    await expect(generateConsequences(userId, turn.id, { generator: fake })).resolves.toStrictEqual(
      { events: 0, contextEntries: 0, relationshipStates: 0 }
    );
  });

  it('refuses to generate consequences for an unanswered turn', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });

    await expect(generateConsequences(userId, turn.id, { generator: fake })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it('refuses to answer the same turn twice', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    await expect(commitChoice(userId, turn.id, turn.choices[1].id)).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  // A model can name ids that do not exist. Dropping them is better than losing
  // the whole beat, and the timeline service would refuse the write regardless.
  it('discards character ids the model invented', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    fake.register(consequencePrompt, ({ vars }) => ({
      events: [
        {
          title: 'Hallucinated cast',
          description: 'x',
          stakes: null,
          participantCharacterIds: [
            vars.storyline.characters[0].id,
            '00000000-0000-0000-0000-000000000000',
          ],
          generationRationale: 'because',
        },
      ],
      contextEntries: [],
      relationshipStates: [],
    }));

    const result = await generateConsequences(userId, turn.id, { generator: fake });
    expect(result.events).toBe(1);

    const [written] = await db.query.events.findMany({
      where: { triggeredByTurnId: turn.id },
      with: { participants: true },
    });
    expect(written.participants).toHaveLength(1);
  });

  /**
   * The reader has to be able to see what their own decision caused.
   *
   * Consequences used to be placed wherever the model named, and it named
   * badly — anchoring at 1500-3500 in a session whose narration had reached
   * 6000. A beat filed above the playhead is invisible to the person who caused
   * it; one filed far below it silently rewrites history they have already read.
   */
  it('lands a consequence at the playhead and moves the playhead to cover it', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    const before = await sessions.getSession(userId, session.id);

    fake.register(consequencePrompt, () => ({
      events: [
        {
          title: 'Placed',
          description: 'x',
          stakes: null,
          participantCharacterIds: [],
          generationRationale: 'because',
        },
      ],
      contextEntries: [],
      relationshipStates: [],
    }));

    await generateConsequences(userId, turn.id, { generator: fake });

    const [written] = await db.query.events.findMany({ where: { triggeredByTurnId: turn.id } });
    // Directly above where the reader stood, not at the far end of a story they
    // have not read yet.
    expect(written.narrativeOrder).toBeGreaterThan(before.playheadOrder);

    const after = await sessions.getSession(userId, session.id);
    expect(after.playheadOrder).toBeGreaterThanOrEqual(written.narrativeOrder);

    const beats = await timeline.listTimeline(storylineId);
    const orders = beats.map((b) => b.narrativeOrder);
    expect(orders).toStrictEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });
});

/**
 * What the reader is allowed to see.
 *
 * A storyline extracted from a real conversation carries the whole of it,
 * including the parts the reader has not reached. Handed all of it and asked
 * for "the next beat", the model narrates the next *real* one — measured on
 * live data, seven turns mapped 1:1 onto extracted beats and quoted their
 * dates, and a twenty-turn session ended by narrating the final beat verbatim.
 *
 * These pin the cut at the only place it can be observed: what the generator
 * was actually handed.
 */
describe('the playhead', () => {
  const orders = (call: { vars: unknown }) =>
    (
      call.vars as { storyline: { timeline: Array<{ narrativeOrder: number }> } }
    ).storyline.timeline.map((b) => b.narrativeOrder);

  it('starts a new session at the first beat, not at the end of the story', async () => {
    const session = await freshSession();
    expect(session.playheadOrder).toBe(1000);
  });

  it('shows the turn only what the reader has reached', async () => {
    const session = await freshSession();

    await generateTurn(userId, session.id, { generator: fake });
    const call = fake.calls.at(-1)!;

    expect(orders(call)).toStrictEqual([1000]);
    // Both halves matter. Without the first, deleting renderTimeline entirely
    // would pass; without the second, the leak this whole change exists to
    // close would go unnoticed.
    expect(call.prompt).toContain('Where things stood');
    expect(call.prompt).not.toContain('The message');
  });

  // The complementary failure: a cut that is correct and never moves is a
  // reader frozen at the opening beat for the rest of the story.
  it('moves on when the reader answers, revealing the next beat', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    expect((await sessions.getSession(userId, session.id)).playheadOrder).toBe(2000);

    await generateTurn(userId, session.id, { generator: fake });
    expect(fake.calls.at(-1)!.prompt).toContain('The message');
  });

  it('tells the turn once the source conversation is spent', async () => {
    const session = await freshSession();

    const first = await generateTurn(userId, session.id, { generator: fake });
    expect((fake.calls.at(-1)!.vars as { beyondScript: boolean }).beyondScript).toBe(false);

    // Past the last extracted beat (2000).
    await commitChoice(userId, first.id, first.choices[0].id);
    const second = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, second.id, second.choices[0].id);
    await generateTurn(userId, session.id, { generator: fake });

    expect((fake.calls.at(-1)!.vars as { beyondScript: boolean }).beyondScript).toBe(true);
  });

  /**
   * Consequences reason about what a decision changed, which needs the story
   * entire — and the relationship states they write must be able to attach to
   * any beat. Narrowing this is the tempting "consistency" fix that would
   * silently break both, so it is pinned here rather than left to a comment.
   */
  it('still gives the consequence stage the whole timeline', async () => {
    const session = await freshSession();
    const turn = await generateTurn(userId, session.id, { generator: fake });
    await commitChoice(userId, turn.id, turn.choices[0].id);

    await generateConsequences(userId, turn.id, { generator: fake });

    const call = fake.calls.filter((c) => c.promptName === 'consequence.commit').at(-1)!;
    expect(orders(call)).toStrictEqual(expect.arrayContaining([1000, 2000]));
  });
});

describe('playing several turns', () => {
  it('runs the loop repeatedly without colliding', async () => {
    const session = await freshSession();

    for (let i = 0; i < 3; i += 1) {
      const turn = await generateTurn(userId, session.id, { generator: fake });
      await commitChoice(userId, turn.id, turn.choices[0].id);
      await generateConsequences(userId, turn.id, { generator: fake });
    }

    const played = await db.query.storyTurns.findMany({ where: { sessionId: session.id } });
    expect(played).toHaveLength(3);
    for (const turn of played) expect(turn.selectedChoiceId).not.toBeNull();

    const orders = (await timeline.listTimeline(storylineId)).map((b) => b.narrativeOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toStrictEqual([...orders].sort((a, b) => a - b));
  });
});
