import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as persons from './persons/persons.service';
import * as storylines from './storylines/storylines.service';
import * as timeline from './timeline/timeline.service';
import * as sessions from './sessions/sessions.service';

/**
 * The write-path obligations in `src/docs/invariants.md` §3–§5.
 *
 * These are the rules that fail silently and sit on the hot path, so they are
 * exercised against a real database rather than mocks: every assertion here is
 * about what Postgres ended up holding, which is the only thing that matters.
 */
const OWNER_CLERK = 'user_writepaths_owner';
const OTHER_CLERK = 'user_writepaths_other';

let ownerId: string;
let otherId: string;
let storylineId: string;
let characterIds: string[];

async function makeUser(clerkId: string, email: string): Promise<string> {
  const [user] = await db.insert(users).values({ clerkId, email }).returning({ id: users.id });
  return user.id;
}

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, OWNER_CLERK));
  await db.delete(users).where(eq(users.clerkId, OTHER_CLERK));
  ownerId = await makeUser(OWNER_CLERK, 'owner@writepaths.local');
  otherId = await makeUser(OTHER_CLERK, 'other@writepaths.local');

  const storyline = await storylines.createStoryline(ownerId, {
    title: 'Write Paths',
    sourceSurface: 'imessage',
  });
  storylineId = storyline.id;
  await storylines.markStatus(ownerId, storylineId, 'ready');

  const self = await persons.getOrCreateSelfPerson(ownerId, 'Blossom');
  const maya = await persons.createPerson(ownerId, { name: 'Maya' });
  const a = await storylines.castCharacter(ownerId, storylineId, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(ownerId, storylineId, maya.id);
  characterIds = [a.id, b.id];
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, OWNER_CLERK));
  await db.delete(users).where(eq(users.clerkId, OTHER_CLERK));
});

describe('§5 creating a turn is two steps that commit as one', () => {
  let sessionId: string;
  beforeEach(async () => {
    sessionId = (await sessions.startSession(ownerId, storylineId)).id;
  });

  it('writes the turn and its options together', async () => {
    const turn = await sessions.openTurn(ownerId, sessionId, 'Something happened.', [
      { label: 'Answer honestly' },
      { label: 'Change the subject' },
    ]);

    expect(turn.selectedChoiceId).toBeNull();
    expect(turn.choices.map((c) => c.label)).toStrictEqual([
      'Answer honestly',
      'Change the subject',
    ]);
    // Positional: the caller's array order is the order they are offered in.
    expect(turn.choices.map((c) => c.orderIndex)).toStrictEqual([0, 1]);
  });

  // Generating a turn costs a model call, so a retry must not produce a second
  // one. PR #23's partial unique index is what makes this a read rather than a
  // second insert.
  it('returns the open turn instead of opening a second', async () => {
    const first = await sessions.openTurn(ownerId, sessionId, 'First beat.', [{ label: 'A' }]);
    const second = await sessions.openTurn(ownerId, sessionId, 'Different beat.', [{ label: 'B' }]);

    expect(second.id).toBe(first.id);
    expect(second.narrativeContent).toBe('First beat.');
  });

  it('opens exactly one turn under concurrent requests', async () => {
    const results = await Promise.allSettled([
      sessions.openTurn(ownerId, sessionId, 'Beat.', [{ label: 'A' }]),
      sessions.openTurn(ownerId, sessionId, 'Beat.', [{ label: 'A' }]),
      sessions.openTurn(ownerId, sessionId, 'Beat.', [{ label: 'A' }]),
    ]);

    const open = await db.query.storyTurns.findMany({
      where: { sessionId, selectedChoiceId: { isNull: true } },
    });
    expect(open).toHaveLength(1);
    // At least one caller must succeed; losers of the race fail loudly rather
    // than silently creating a duplicate.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('allows a closing beat with no options at all', async () => {
    const turn = await sessions.openTurn(ownerId, sessionId, 'And that was that.', []);
    expect(turn.choices).toStrictEqual([]);
  });
});

describe('§5 answering a turn', () => {
  let sessionId: string;
  let turn: Awaited<ReturnType<typeof sessions.openTurn>>;

  beforeEach(async () => {
    sessionId = (await sessions.startSession(ownerId, storylineId)).id;
    turn = await sessions.openTurn(ownerId, sessionId, 'A decision.', [
      { label: 'Say it' },
      { label: 'Say nothing' },
    ]);
  });

  // §4: an answered turn with no timestamp reads as valid. They are one fact and
  // are written in one statement.
  it('sets the choice and the timestamp together', async () => {
    const answered = await sessions.answerTurn(ownerId, turn.id, turn.choices[0].id);

    expect(answered.selectedChoiceId).toBe(turn.choices[0].id);
    expect(answered.respondedAt).toBeInstanceOf(Date);
  });

  // §5: forget this and a session looks idle while someone is actively playing,
  // so the arc summary recomputes underneath them.
  it('moves the session idle clock', async () => {
    const before = (await sessions.getSession(ownerId, sessionId)).lastActiveAt;
    await new Promise((r) => setTimeout(r, 10));

    await sessions.answerTurn(ownerId, turn.id, turn.choices[0].id);

    const after = (await sessions.getSession(ownerId, sessionId)).lastActiveAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('refuses to answer the same turn twice', async () => {
    await sessions.answerTurn(ownerId, turn.id, turn.choices[0].id);

    await expect(sessions.answerTurn(ownerId, turn.id, turn.choices[1].id)).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  // invariants.md §3 singles this out as "the most likely to bite, because it is
  // the only one on the hot write path" — both ids arrive from the client.
  it('refuses a choice that was never offered on this turn', async () => {
    const otherSession = await sessions.startSession(ownerId, storylineId);
    const otherTurn = await sessions.openTurn(ownerId, otherSession.id, 'Elsewhere.', [
      { label: 'Not yours' },
    ]);

    await expect(
      sessions.answerTurn(ownerId, turn.id, otherTurn.choices[0].id)
    ).rejects.toBeInstanceOf(ValidationError);

    // And nothing was written.
    const untouched = await db.query.storyTurns.findFirst({ where: { id: turn.id } });
    expect(untouched!.selectedChoiceId).toBeNull();
    expect(untouched!.respondedAt).toBeNull();
  });

  it("refuses to answer another user's turn", async () => {
    await expect(sessions.answerTurn(otherId, turn.id, turn.choices[0].id)).rejects.toBeInstanceOf(
      NotFoundError
    );

    const untouched = await db.query.storyTurns.findFirst({ where: { id: turn.id } });
    expect(untouched!.selectedChoiceId).toBeNull();
  });

  // A double click. A read-then-write would let the second overwrite the first's
  // answer and timestamp; the guard is in the WHERE clause precisely so it cannot.
  it('records exactly one answer under concurrent clicks', async () => {
    const results = await Promise.allSettled([
      sessions.answerTurn(ownerId, turn.id, turn.choices[0].id),
      sessions.answerTurn(ownerId, turn.id, turn.choices[1].id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const stored = await db.query.storyTurns.findFirst({ where: { id: turn.id } });
    expect(stored!.selectedChoiceId).not.toBeNull();
  });
});

describe('narrativeOrder allocation', () => {
  it('appends in gaps of 1000', async () => {
    const story = await storylines.createStoryline(ownerId, {
      title: 'Ordering',
      sourceSurface: 'imessage',
    });

    const first = await timeline.appendEvent(ownerId, story.id, {
      origin: 'extracted',
      title: 'One',
      description: 'First beat',
    });
    const second = await timeline.appendEvent(ownerId, story.id, {
      origin: 'extracted',
      title: 'Two',
      description: 'Second beat',
    });

    expect(first.narrativeOrder).toBe(1000);
    expect(second.narrativeOrder).toBe(2000);
  });

  it('inserts a consequence between two existing beats', async () => {
    const story = await storylines.createStoryline(ownerId, {
      title: 'Midpoint',
      sourceSurface: 'imessage',
    });
    await timeline.appendEvent(ownerId, story.id, {
      origin: 'extracted',
      title: 'One',
      description: 'x',
    });
    await timeline.appendEvent(ownerId, story.id, {
      origin: 'extracted',
      title: 'Two',
      description: 'x',
    });

    const session = await sessions.startSession(ownerId, storylineId);
    const turn = await sessions.openTurn(ownerId, session.id, 'Decide.', [{ label: 'A' }]);

    const inserted = await timeline.insertEventAfter(ownerId, story.id, 1000, {
      origin: 'conversation_generated',
      triggeredByTurnId: turn.id,
      generationRationale: 'the user pushed back',
      title: 'A different answer',
      description: 'x',
    });

    expect(inserted.narrativeOrder).toBe(1500);
    const beats = await timeline.listTimeline(story.id);
    expect(beats.map((e) => e.narrativeOrder)).toStrictEqual([1000, 1500, 2000]);
  });

  // Two appends racing would otherwise read the same maximum and pick the same
  // slot. Since PR #23 that is a unique violation rather than corruption, and the
  // per-storyline row lock turns it into a short wait instead.
  it('allocates distinct orders under concurrent appends', async () => {
    const story = await storylines.createStoryline(ownerId, {
      title: 'Racing',
      sourceSurface: 'imessage',
    });

    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((t) =>
        timeline.appendEvent(ownerId, story.id, {
          origin: 'extracted',
          title: t,
          description: 'x',
        })
      )
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const orders = (await timeline.listTimeline(story.id)).map((e) => e.narrativeOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toStrictEqual([1000, 2000, 3000]);
  });
});

describe('§4 conditional columns on events', () => {
  it('carries lineage on a generated beat and none on an extracted one', async () => {
    const session = await sessions.startSession(ownerId, storylineId);
    const turn = await sessions.openTurn(ownerId, session.id, 'Decide.', [{ label: 'A' }]);
    const story = await storylines.createStoryline(ownerId, {
      title: 'Lineage',
      sourceSurface: 'imessage',
    });

    const extracted = await timeline.appendEvent(ownerId, story.id, {
      origin: 'extracted',
      title: 'From the messages',
      description: 'x',
    });
    const generated = await timeline.appendEvent(ownerId, story.id, {
      origin: 'conversation_generated',
      triggeredByTurnId: turn.id,
      generationRationale: 'because the user chose otherwise',
      title: 'From a decision',
      description: 'x',
    });

    expect(extracted.triggeredByTurnId).toBeNull();
    expect(extracted.generationRationale).toBeNull();
    expect(generated.triggeredByTurnId).toBe(turn.id);
    expect(generated.generationRationale).toBe('because the user chose otherwise');
  });
});

describe('§3 cross-scope integrity on timeline writes', () => {
  it('refuses to credit a character from another storyline', async () => {
    const other = await storylines.createStoryline(ownerId, {
      title: 'Elsewhere',
      sourceSurface: 'imessage',
    });

    await expect(
      timeline.appendEvent(ownerId, other.id, {
        origin: 'extracted',
        title: 'Wrong cast',
        description: 'x',
        // Real character ids, but they belong to a different story.
        participantCharacterIds: characterIds,
      })
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await timeline.listTimeline(other.id)).toHaveLength(0);
  });

  it('credits characters that do belong to the storyline', async () => {
    const event = await timeline.appendEvent(ownerId, storylineId, {
      origin: 'extracted',
      title: 'Right cast',
      description: 'x',
      participantCharacterIds: characterIds,
    });

    const withParticipants = await db.query.events.findFirst({
      where: { id: event.id },
      with: { participants: true },
    });
    expect(withParticipants!.participants).toHaveLength(2);
  });

  it('refuses a relationship state whose event is from another storyline', async () => {
    const relationship = await storylines.relateCharacters(
      ownerId,
      storylineId,
      characterIds[0],
      characterIds[1]
    );
    const elsewhere = await storylines.createStoryline(ownerId, {
      title: 'Other Timeline',
      sourceSurface: 'imessage',
    });
    const foreignEvent = await timeline.appendEvent(ownerId, elsewhere.id, {
      origin: 'extracted',
      title: 'Unrelated',
      description: 'x',
    });

    await expect(
      timeline.recordRelationshipState({
        relationshipId: relationship.id,
        eventId: foreignEvent.id,
        dynamic: { closeness: 'closer' },
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to append to another user's storyline", async () => {
    await expect(
      timeline.appendEvent(otherId, storylineId, {
        origin: 'extracted',
        title: 'Not yours',
        description: 'x',
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('idle sessions', () => {
  it('finds sessions untouched since a threshold, and not fresh ones', async () => {
    const fresh = await sessions.startSession(ownerId, storylineId);

    // Everything created in this run is newer than a threshold in the past, and
    // older than one in the future.
    const past = await sessions.findIdleSessions(new Date(Date.now() - 60_000));
    const future = await sessions.findIdleSessions(new Date(Date.now() + 60_000));

    expect(past.map((s) => s.id)).not.toContain(fresh.id);
    expect(future.map((s) => s.id)).toContain(fresh.id);
  });
});
