import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/index';
import {
  characterRelationships,
  characters,
  contextEntries,
  eventParticipants,
  events,
  personRelationships,
  persons,
  storylines,
  storylineSessions,
  storyTemplates,
} from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { storyTemplateSchema, type StoryTemplate } from '@/lib/pool/template';
import { ConflictError, NotFoundError } from '@/lib/utils/errors';
import { GUEST_SELF_NAME } from '../guests/guests.service';
import * as sessions from '../sessions/sessions.service';
import * as sessionWriter from '../sessions/sessions.writer';
import { Executor } from '../executor';

/**
 * The next story, Netflix-style: chosen when one ends, started when the reader
 * goes on.
 *
 * Pool stories are templates, and starting one copies it into the reader's own
 * rows — persons, characters, events, a session — because every storyline
 * belongs to one player (invariants.md §3). The copy keeps only
 * `storylines.template_id` back to the pool, and that is `set null`, so an
 * author leaving takes their story out of the pool and out of nobody's hands.
 */

export type NextStory = {
  templateId: string;
  origin: 'seed' | 'reborn' | 'reddit';
  title: string;
  premise: string;
};

/**
 * Picks a pool story for this reader: ready, never their own, never one they
 * have played, and not by the author of the story they just finished. Players'
 * stories first, seeds when there are none left for them.
 *
 * Literal identifiers throughout, for the subquery reason given on
 * `playthroughsForEvents`.
 */
async function choose(tx: Executor, userId: string, lastAuthor: string | null) {
  const [row] = await tx
    .select({ id: storyTemplates.id })
    .from(storyTemplates)
    .where(
      sql`"story_templates"."status" = 'ready'
        and ("story_templates"."user_id" is null or "story_templates"."user_id" <> ${userId})
        and (${lastAuthor}::uuid is null or "story_templates"."user_id" is null
             or "story_templates"."user_id" <> ${lastAuthor}::uuid)
        and not exists (
          select 1 from "storylines" "played"
          where "played"."user_id" = ${userId} and "played"."template_id" = "story_templates"."id"
        )`
    )
    .orderBy(sql`("story_templates"."origin" = 'reborn') desc, random()`)
    .limit(1);
  return row?.id ?? null;
}

async function templateIfReady(tx: Executor, templateId: string) {
  const [row] = await tx
    .select({
      id: storyTemplates.id,
      origin: storyTemplates.origin,
      content: storyTemplates.content,
    })
    .from(storyTemplates)
    .where(and(eq(storyTemplates.id, templateId), eq(storyTemplates.status, 'ready')))
    .limit(1);
  if (!row?.content) return null;
  return { id: row.id, origin: row.origin, content: storyTemplateSchema.parse(row.content) };
}

/** Who wrote the template a storyline was copied from, if anyone. */
async function authorOf(tx: Executor, storylineId: string): Promise<string | null> {
  const [row] = await tx
    .select({ author: storyTemplates.userId })
    .from(storylines)
    .innerJoin(storyTemplates, eq(storyTemplates.id, storylines.templateId))
    .where(eq(storylines.id, storylineId))
    .limit(1);
  return row?.author ?? null;
}

/**
 * The story offered after this session, or null while it is going or when the
 * pool has nothing for this reader.
 *
 * Chosen once and remembered on the session, so the card the reader saw and the
 * story they get are the same one. If it has left the pool since, another is
 * chosen.
 */
export async function nextStoryFor(userId: string, sessionId: string): Promise<NextStory | null> {
  const session = await sessions.getSession(userId, sessionId);
  if (!session.endedAt) return null;

  const [row] = await db
    .select({ next: storylineSessions.nextTemplateId })
    .from(storylineSessions)
    .where(eq(storylineSessions.id, sessionId));

  let template = row?.next ? await templateIfReady(db, row.next) : null;
  if (!template) {
    const chosen = await choose(db, userId, await authorOf(db, session.storylineId));
    if (!chosen) return null;
    await db
      .update(storylineSessions)
      .set({ nextTemplateId: chosen })
      .where(eq(storylineSessions.id, sessionId));
    template = await templateIfReady(db, chosen);
    if (!template) return null;
  }

  return {
    templateId: template.id,
    origin: template.origin,
    title: template.content.title,
    premise: template.content.premise,
  };
}

/**
 * Starts the next story after an ended one, and returns its session.
 *
 * Idempotent per ended session: the new session is remembered, and asking
 * again returns it, so a retried request or a second tap starts one story.
 * Free — the first beat is an ordinary `/turn`.
 */
export async function startNextStory(
  userId: string,
  sessionId: string,
  { autoplay }: { autoplay: boolean }
): Promise<{ sessionId: string }> {
  const session = await sessions.getSession(userId, sessionId);
  if (!session.endedAt) throw new ConflictError('This story has not ended');

  const offered = await nextStoryFor(userId, sessionId);

  const started = await db.transaction(async (tx) => {
    // Locks the ended session, so two requests cannot both find no next session.
    const [locked] = await tx
      .select({ nextSessionId: storylineSessions.nextSessionId })
      .from(storylineSessions)
      .where(eq(storylineSessions.id, sessionId))
      .for('update');
    if (locked?.nextSessionId) return { sessionId: locked.nextSessionId, origin: null };

    if (!offered) throw new NotFoundError('Next story', sessionId);
    const template = await templateIfReady(tx, offered.templateId);
    if (!template) throw new NotFoundError('Next story', sessionId);

    const next = await instantiateTemplate(tx, userId, template.id, template.content);
    await tx
      .update(storylineSessions)
      .set({ nextSessionId: next })
      .where(eq(storylineSessions.id, sessionId));
    return { sessionId: next, origin: template.origin };
  });

  // Only when this call started it: a retry returning the same story is not a second start.
  if (started.origin) {
    await track(userId, {
      name: 'next_story_started',
      properties: { origin: started.origin, autoplay },
    });
  }
  return { sessionId: started.sessionId };
}

/**
 * Copies a template into the reader's own rows and opens a playthrough on it.
 *
 * The same write the scripted onboarding story makes (`writeStory`), from the
 * template instead of a script: new persons for the cast, the reader's self as
 * protagonist, the opening as `extracted` beats everyone takes part in (so the
 * whole cast is someone the reader has met), and a session on the last of them.
 * No first turn: that is the reader's first `/turn`.
 */
export async function instantiateTemplate(
  tx: Executor,
  userId: string,
  templateId: string,
  template: StoryTemplate
): Promise<string> {
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

  const [storyline] = await tx
    .insert(storylines)
    .values({
      userId,
      title: template.title,
      sourceSurface: 'imessage',
      setting: template.setting,
      tone: template.tone,
      status: 'ready',
      templateId,
    })
    .returning({ id: storylines.id });

  const [protagonist] = await tx
    .insert(characters)
    .values({ storylineId: storyline.id, personId: self.id, role: 'protagonist', ...template.self })
    .returning({ id: characters.id });

  const castIds: string[] = [];
  for (const member of template.cast) {
    const [person] = await tx
      .insert(persons)
      .values({ userId, name: member.name, pronouns: member.pronouns })
      .returning({ id: persons.id });

    const [pa, pb] = [self.id, person.id].sort();
    await tx.insert(personRelationships).values({
      userId,
      personAId: pa,
      personBId: pb,
      relationshipType: member.relationshipType,
    });

    const [character] = await tx
      .insert(characters)
      .values({
        storylineId: storyline.id,
        personId: person.id,
        role: member.role,
        description: member.description,
        want: member.want,
        avoids: member.avoids,
        voiceProfileOverride: member.voiceTone ? { tone: member.voiceTone } : undefined,
      })
      .returning({ id: characters.id });
    castIds.push(character.id);

    const [ca, cb] = [protagonist.id, character.id].sort();
    await tx.insert(characterRelationships).values({
      storylineId: storyline.id,
      characterAId: ca,
      characterBId: cb,
      baselineDynamic: {
        ...(member.closeness ? { closeness: member.closeness } : {}),
        ...(member.tension ? { tension: member.tension } : {}),
      },
    });
  }

  let last: { id: string; narrativeOrder: number } | undefined;
  for (const [i, beat] of template.opening.entries()) {
    const [event] = await tx
      .insert(events)
      .values({
        storylineId: storyline.id,
        narrativeOrder: (i + 1) * 1000,
        origin: 'extracted',
        title: beat.title,
        description: beat.description,
        engagementScore: beat.engagementScore,
      })
      .returning({ id: events.id, narrativeOrder: events.narrativeOrder });
    await tx
      .insert(eventParticipants)
      .values(
        [protagonist.id, ...castIds].map((characterId) => ({ eventId: event.id, characterId }))
      );
    last = event;
  }
  // The schema requires two opening beats, so this is unreachable.
  if (!last) throw new ConflictError('A pool story has no opening');

  if (template.background.length) {
    await tx.insert(contextEntries).values(
      template.background.map((content) => ({
        storylineId: storyline.id,
        content,
        source: 'inferred' as const,
      }))
    );
  }

  const session = await sessionWriter.insertSession(tx, userId, storyline.id, last.id);
  await sessionWriter.raisePlayheadTo(tx, session.id, last.narrativeOrder);
  return session.id;
}
