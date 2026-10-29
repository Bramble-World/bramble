import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/index';
import {
  characterRelationships,
  characters,
  contextEntries,
  eventParticipants,
  events,
  personRelationships,
  persons,
  storylineSessions,
  storylines,
  users,
} from '@/db/schema/tables';
import { InternalServerError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import { imessageFromModel } from '@/lib/surfaces/imessage.surface';
import { track } from '@/lib/analytics/analytics';
import { Naming, openingById, type Opening } from '@/lib/onboarding/openings';
import * as sessionReader from '../sessions/sessions.reader';
import * as sessionWriter from '../sessions/sessions.writer';
import { TurnWithChoices } from '../sessions/sessions.types';
import { GUEST_SELF_NAME } from '../guests/guests.service';
import { Executor } from '../executor';

/**
 * A guest's story, from the naming screen to beat 1.
 *
 * Everything the import pipeline would have produced from a conversation —
 * people, a storyline, a cast, a timeline the model continues from — written
 * instead from a scripted opening and the three things the reader chose: a
 * name, a relationship and (optionally) pronouns. Beat 1 is the opening's own
 * script, so the first thing the reader sees costs no model call and reads
 * exactly as the app's design intends; beats 2 and 3 go through the ordinary
 * `POST /sessions/{id}/turn`, which continues from the setup written here.
 */

export type GuestStory = {
  sessionId: string;
  storylineId: string;
  storylineTitle: string;
  person: { id: string; name: string; isSelf: boolean };
  /**
   * The turn in front of the reader: beat 1 on a fresh story. On a repeated
   * call it is whichever turn is open, or null once they have answered it and
   * the next one has not been written — `POST /sessions/{id}/turn` brings it.
   */
  turn: TurnWithChoices | null;
};

/**
 * Writes the guest's story, or returns the one they already have.
 *
 * **One story per guest, and a repeat is not an error.** The call is the first
 * write a fresh install makes, on a phone that may lose the response; the
 * client's remedy for a lost response is to send it again, and a 409 would leave
 * it holding an error and no session id. Returning the existing story makes the
 * retry safe, the way a repeated answer reconciles rather than conflicts. The
 * story returned is the one that exists — a second name in the retry does not
 * rewrite it, because beat 1 has already been shown with the first.
 *
 * One transaction, with the guest's row locked first: two concurrent calls
 * serialise on that lock, and the second finds the first's story rather than
 * writing a second one. A story half-written — a storyline with no session, a
 * session with no beat — would read as perfectly valid rows.
 */
export async function createGuestStory(
  userId: string,
  openingId: string,
  naming: Naming,
  options: { pronounsGiven: boolean }
): Promise<{ story: GuestStory; created: boolean }> {
  const opening = openingById(openingId);
  if (!opening) {
    throw new ValidationError('That opening does not exist', { openingId: 'Unknown opening' });
  }

  const result = await db.transaction(async (tx) => {
    // The lock is the whole of the one-story guarantee: without it two calls
    // both see no story and both write one.
    const [guest] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isGuest, true)))
      .for('update');
    if (!guest) throw new NotFoundError('Guest', userId);

    const existing = await existingStory(tx, userId);
    if (existing) return { story: existing, created: false };

    return { story: await writeStory(tx, userId, opening, naming), created: true };
  });

  if (result.created) {
    // After the commit, so a rolled-back story is never counted. Neither event
    // carries the name or the pronouns themselves — only which chip was picked,
    // and whether pronouns were chosen at all.
    await track(userId, {
      name: 'person_named',
      properties: {
        relationship: naming.relationship,
        pronouns_given: options.pronounsGiven ? 'yes' : 'no',
      },
    });
    await track(userId, { name: 'guest_beat_played', properties: { n: 1 } });
  }

  return result;
}

async function writeStory(
  tx: Executor,
  userId: string,
  opening: Opening,
  naming: Naming
): Promise<GuestStory> {
  const setup = opening.setup(naming);
  const beat = opening.beat1(naming);

  // The self person is provisioned with the guest; this only covers a guest
  // row made some other way, so the story never fails for want of one.
  const self =
    (
      await tx
        .select({ id: persons.id })
        .from(persons)
        .where(and(eq(persons.userId, userId), eq(persons.isSelf, true)))
    )[0] ??
    (
      await tx
        .insert(persons)
        .values({ userId, name: GUEST_SELF_NAME, isSelf: true })
        .returning({ id: persons.id })
    )[0];

  const [named] = await tx
    .insert(persons)
    .values({ userId, name: naming.name, pronouns: naming.pronouns })
    .returning({ id: persons.id, name: persons.name, isSelf: persons.isSelf });

  // The chip they picked, as the structural fact about these two people — the
  // same table an import records "oldest friend" in. Sorted, for the CHECK.
  const [a, b] = [self.id, named.id].sort();
  await tx.insert(personRelationships).values({
    userId,
    personAId: a,
    personBId: b,
    relationshipType: naming.relationship,
  });

  const [storyline] = await tx
    .insert(storylines)
    .values({
      userId,
      title: setup.storyline.title,
      sourceSurface: 'imessage',
      setting: setup.storyline.setting,
      tone: setup.storyline.tone,
      // Ready at once: there is no extraction to wait for.
      status: 'ready',
    })
    .returning({ id: storylines.id, title: storylines.title });

  const [protagonist] = await tx
    .insert(characters)
    .values({
      storylineId: storyline.id,
      personId: self.id,
      role: 'protagonist',
      ...setup.self,
    })
    .returning({ id: characters.id });
  const [counterpart] = await tx
    .insert(characters)
    .values({
      storylineId: storyline.id,
      personId: named.id,
      role: 'supporting',
      ...setup.named,
    })
    .returning({ id: characters.id });

  const [ca, cb] = [protagonist.id, counterpart.id].sort();
  await tx.insert(characterRelationships).values({
    storylineId: storyline.id,
    characterAId: ca,
    characterBId: cb,
    baselineDynamic: setup.baseline,
  });

  // `extracted`, because these beats play the part extraction plays for an
  // import: the canon the story starts from, below which nothing was steered.
  // Gaps of 1000 (invariants.md §6). Both characters take part in every beat,
  // which is what makes the named person someone the reader has met.
  let last: { id: string; narrativeOrder: number } | undefined;
  for (const [i, beatSetup] of setup.events.entries()) {
    const [event] = await tx
      .insert(events)
      .values({
        storylineId: storyline.id,
        narrativeOrder: (i + 1) * 1000,
        origin: 'extracted',
        title: beatSetup.title,
        description: beatSetup.description,
        // Scored, so the story appears in the reader's world once it is saved —
        // the ranked read excludes unscored beats.
        engagementScore: beatSetup.engagementScore,
      })
      .returning({ id: events.id, narrativeOrder: events.narrativeOrder });
    await tx.insert(eventParticipants).values([
      { eventId: event.id, characterId: protagonist.id },
      { eventId: event.id, characterId: counterpart.id },
    ]);
    last = event;
  }
  if (!last) throw new InternalServerError(`Opening ${opening.id} has no setup beats`);

  if (setup.context.length) {
    await tx.insert(contextEntries).values(
      setup.context.map((content) => ({
        storylineId: storyline.id,
        content,
        source: 'inferred' as const,
      }))
    );
  }

  // Opened at the last setup beat, with the playhead on it: the reader is in
  // the moment the texts arrive, and the model at beat 2 sees the whole setup.
  // Recording it as the beat the session started from also means the world
  // screen offers "continue" on that moment once the story is saved.
  const session = await sessionWriter.insertSession(tx, userId, storyline.id, last.id);
  await sessionWriter.raisePlayheadTo(tx, session.id, last.narrativeOrder);

  // Through the same validation a generated text goes through, so a scripted
  // surface cannot be anything a written one could not.
  const surface = imessageFromModel(
    {
      clockTime: beat.surface.clockTime,
      dateLabel: beat.surface.dateLabel,
      notifications: beat.surface.texts.map((text) => ({
        senderCharacterId: counterpart.id,
        text,
      })),
    },
    [{ id: counterpart.id, personId: named.id, isSelf: false }]
  );

  const turnId = await sessionWriter.insertTurn(tx, session.id, 1, {
    headline: beat.headline,
    narrativeContent: beat.narrative,
    choices: beat.choices.map((label) => ({ label })),
    surfaces: surface ? [surface] : [],
  });
  const turn = await sessionReader.getTurn(tx, turnId);
  if (!turn) throw new InternalServerError(`Turn ${turnId} vanished inside its own transaction`);

  return {
    sessionId: session.id,
    storylineId: storyline.id,
    storylineTitle: storyline.title,
    person: named,
    turn,
  };
}

/** The guest's story if they already have one: their first storyline and its newest session. */
async function existingStory(tx: Executor, userId: string): Promise<GuestStory | null> {
  const [row] = await tx
    .select({
      storylineId: storylines.id,
      storylineTitle: storylines.title,
      sessionId: storylineSessions.id,
    })
    .from(storylines)
    .innerJoin(storylineSessions, eq(storylineSessions.storylineId, storylines.id))
    .where(eq(storylines.userId, userId))
    .orderBy(asc(storylines.createdAt), desc(storylineSessions.createdAt))
    .limit(1);
  if (!row) return null;

  const [person] = await tx
    .select({ id: persons.id, name: persons.name, isSelf: persons.isSelf })
    .from(characters)
    .innerJoin(persons, eq(persons.id, characters.personId))
    .where(and(eq(characters.storylineId, row.storylineId), eq(persons.isSelf, false)))
    .orderBy(asc(characters.createdAt))
    .limit(1);
  if (!person) return null;

  return { ...row, person, turn: await sessionReader.getOpenTurn(tx, row.sessionId) };
}
