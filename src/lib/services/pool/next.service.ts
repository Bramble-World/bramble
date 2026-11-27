import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { linkDuetSide, partnerNameFor } from '../duets/duets.service';

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
  origin: 'seed' | 'reborn' | 'reddit' | 'chatgpt' | 'duet';
  title: string;
  hook: string;
  openingLines: string[];
  /** Written from another player's past: not by the team, and not their own from ChatGPT. */
  fromPool: boolean;
  /** Written for this reader from what they shared in ChatGPT. */
  fromChatGPT: boolean;
  /**
   * One side of a story for two (`duets`): the other player's first name, as
   * they gave it. Null for every other story.
   */
  withPartner: string | null;
};

/**
 * Where an ended session's next story stands, so the app can tell "nothing to
 * offer" from "not ready yet".
 *
 * - `ready`: `next` is the story.
 * - `preparing`: nothing yet, but a story this reader asked ChatGPT for is
 *   being written, and becomes `next` when it's done: read the session again.
 * - `none`: nothing can be offered: the reader has played everything the pool
 *   has for them, and nothing is being written.
 */
export type NextStatus = 'ready' | 'preparing' | 'none';

/** How the reader went on to the next story. */
export const NEXT_STORY_HOW = ['countdown', 'begin_now', 'later'] as const;
export type NextStoryHow = (typeof NEXT_STORY_HOW)[number];

/**
 * The oldest story written for this reader that they haven't started yet:
 * from ChatGPT, or their side of a story for two. It goes before anything from
 * the pool: they asked for it, or a friend is waiting on it.
 */
async function ownFromChatGPT(tx: Executor, userId: string) {
  const [row] = await tx
    .select({ id: storyTemplates.id })
    .from(storyTemplates)
    .where(
      sql`"story_templates"."status" = 'ready'
        and "story_templates"."origin" in ('chatgpt', 'duet')
        and "story_templates"."user_id" = ${userId}
        and not exists (
          select 1 from "storylines" "played"
          where "played"."user_id" = ${userId} and "played"."template_id" = "story_templates"."id"
        )`
    )
    .orderBy(storyTemplates.createdAt)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Picks the next story for this reader. Their own stories from ChatGPT first.
 * Otherwise one from the pool: ready, never their own, never one they have
 * played, and not by the author of the story they just finished. Players'
 * stories first, seeds when there are none left for them.
 *
 * A `chatgpt` story is never in the pool: it is only ever offered to the
 * player it was written for (invariants.md §3).
 *
 * Literal identifiers throughout, for the subquery reason given on
 * `playthroughsForEvents`.
 */
async function choose(tx: Executor, userId: string, lastAuthor: string | null) {
  const own = await ownFromChatGPT(tx, userId);
  if (own) return own;

  const [row] = await tx
    .select({ id: storyTemplates.id })
    .from(storyTemplates)
    .where(
      sql`"story_templates"."status" = 'ready'
        and "story_templates"."origin" not in ('chatgpt', 'duet')
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

/**
 * How long after a story ends its next one waits for a story the reader asked
 * ChatGPT for that is still being written, before a pool story is chosen
 * instead. A story takes about 45 s to write; the card says "finding your next
 * story…" meanwhile (`nextStatus: preparing`).
 */
export const OWN_STORY_WAIT_MS = 60_000;

/** Whether a story this reader asked ChatGPT for is still being written. */
async function ownFromChatGPTInProgress(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: storyTemplates.id })
    .from(storyTemplates)
    .where(
      and(
        eq(storyTemplates.userId, userId),
        eq(storyTemplates.origin, 'chatgpt'),
        inArray(storyTemplates.status, ['pending', 'generating'])
      )
    )
    .limit(1);
  return row !== undefined;
}

/** The status beside `nextStoryFor`'s answer for an ended session. */
export async function nextStatusFor(userId: string, next: NextStory | null): Promise<NextStatus> {
  if (next) return 'ready';
  return (await ownFromChatGPTInProgress(userId)) ? 'preparing' : 'none';
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
  // A story they asked ChatGPT for, written since the card was chosen, takes
  // its place: it's the one they're waiting for.
  if (
    template &&
    template.origin !== 'chatgpt' &&
    template.origin !== 'duet' &&
    (await ownFromChatGPT(db, userId))
  ) {
    template = null;
  }
  if (!template) {
    // Their own story is nearly written: wait for it rather than hand them a
    // stranger's, which would put theirs off for a whole story. Nothing is
    // remembered meanwhile, so the next read chooses afresh.
    const waiting = Date.now() - session.endedAt.getTime() < OWN_STORY_WAIT_MS;
    if (
      waiting &&
      !(await ownFromChatGPT(db, userId)) &&
      (await ownFromChatGPTInProgress(userId))
    ) {
      return null;
    }
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
    hook: template.content.hook,
    openingLines: template.content.openingLines,
    fromPool: template.origin === 'reborn' || template.origin === 'reddit',
    fromChatGPT: template.origin === 'chatgpt',
    withPartner: template.origin === 'duet' ? await partnerNameFor(template.id) : null,
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
  { how }: { how: NextStoryHow }
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

    const copied = await copyTemplate(tx, userId, template.id, template.content);
    // Their side of a story for two: say which storyline and character is whose.
    if (template.origin === 'duet') {
      await linkDuetSide(tx, userId, template.id, copied.storylineId, copied.castCharacterIds);
    }
    const next = copied.sessionId;
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
      properties: { origin: started.origin, how },
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
  return (await copyTemplate(tx, userId, templateId, template)).sessionId;
}

/** `instantiateTemplate`, also saying what it made: the storyline, and the cast's characters in order. */
async function copyTemplate(
  tx: Executor,
  userId: string,
  templateId: string,
  template: StoryTemplate
): Promise<{ sessionId: string; storylineId: string; castCharacterIds: string[] }> {
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
  return { sessionId: session.id, storylineId: storyline.id, castCharacterIds: castIds };
}
