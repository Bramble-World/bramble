import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { StorylineContext } from '@/lib/services/generation/generation.types';
import { renderTimeline, STAKES_WINDOW } from './timeline';
import { shortId } from './short-ids';
import { CACHE_BREAK, joinLines, PromptLine, steppedBreaks, withBreaks } from './cache';
import { PRONOUN_LABELS } from './turn.prompt';
import { relationshipToReader } from './relationship';

export type ConsequenceVars = {
  storyline: StorylineContext;
  /**
   * Where the session's reader is. Not shown to the model, which is given the
   * whole timeline: it only says where this decision's beats will land, so the
   * prompt cache is cut before that point (see `stableBeats`).
   */
  playheadOrder: number;
  /**
   * On one side of a story for two only: the character who is the other
   * player. Each beat then says whether they would know it happened, and what
   * they would know crosses into their side (crossings). Absent everywhere
   * else, and the prompt is then exactly the usual one.
   */
  partnerCharacterId?: string;
  /** What the user was shown, and what they picked. */
  decision: {
    headline: string | null;
    narrativeContent: string;
    /** What was on screen with it — the texts the decision was a reply to. */
    surfaceLines: string[];
    chosenLabel: string;
    chosenDescription: string | null;
    rejectedLabels: string[];
  };
};

/** One beat a decision caused. Shared with the duet version, which adds one field. */
const consequenceEventSchema = z.object({
  title: z.string().min(1).describe('A short label for the beat, under 60 characters.'),
  description: z.string().min(1).describe('What now happens, 1-3 sentences.'),
  stakes: z.string().nullable().describe('What is at risk. Null if nothing new is.'),
  participantCharacterIds: z
    .array(z.string())
    .describe('Character ids from the cast who are involved. May be empty.'),
  actorCharacterId: z
    .string()
    .nullable()
    .describe(
      'The one character who set this beat in motion, if a single person did. Null when it is something that happened to them rather than something someone did.'
    ),
});

/**
 * What a decision changed about the story.
 *
 * Everything is still allowed to be empty, because a model forced to produce an
 * event every time will invent one. But the earlier wording — that returning
 * nothing was "the common case and the correct one" — suppressed almost
 * everything: across nineteen real decisions it produced two events, no
 * background and no relationship movement at all. Offers made, budgets proposed
 * and things said out loud all recorded nothing, so steering the story left no
 * trace, which is the one thing the feature exists to do.
 *
 * `dynamic` is flattened into three nullable strings rather than a nested
 * object, because nested optional structures are where structured-output modes
 * are least reliable. It is reassembled on the way to the database.
 */
export const consequenceOutputSchema = z.object({
  events: z
    .array(consequenceEventSchema)
    .max(2)
    .describe(
      'At most two new beats recording what happened, whoever caused it — the reader acting, or another character replying, refusing, or doing something of their own. Empty only when the choice changed nothing at all.'
    ),

  contextEntries: z
    .array(
      z.object({
        content: z.string().min(1).describe('Backstory this choice revealed, one sentence.'),
        characterId: z
          .string()
          .nullable()
          .describe('Whose backstory, or null for the whole story.'),
      })
    )
    .max(3),

  relationshipStates: z
    .array(
      z.object({
        relationshipId: z.string().describe('An id from the relationships listed below.'),
        closeness: z.string().nullable(),
        tension: z.string().nullable(),
        powerBalance: z.string().nullable(),
      })
    )
    .max(3)
    .describe('Only relationships this choice actually moved.'),
});

export type ConsequenceOutput = z.infer<typeof consequenceOutputSchema>;

/**
 * The duet version: each beat also says whether the other player's character
 * would know it happened. Only those cross into their side.
 */
export const duetConsequenceOutputSchema = consequenceOutputSchema.extend({
  events: z
    .array(
      consequenceEventSchema.extend({
        partnerKnows: z
          .boolean()
          .describe(
            'True only if the other player would know this happened: they were told, texted, shown, or were there. False for anything private to the reader.'
          ),
      })
    )
    .max(2)
    .describe(consequenceOutputSchema.shape.events.description ?? ''),
});

export type DuetConsequenceOutput = z.infer<typeof duetConsequenceOutputSchema>;

/** The rules a story for two adds: who the other player is, and what they'd know. */
const PARTNER_RULES = [
  '',
  'This story is shared: one other character is played by another real person, in',
  'their own version of it. For each beat, say whether that character would know',
  'it happened (partnerKnows): only when they were told, texted, shown, or there.',
  'Anything the reader keeps to themselves is false. Never decide what that',
  'character does next; only record what the reader did that reaches them.',
];

export const consequencePrompt: PromptSpec<ConsequenceVars, ConsequenceOutput> = {
  name: 'consequence.commit',
  stage: 'consequence',
  schema: consequenceOutputSchema,

  render: ({ storyline, decision, playheadOrder, partnerCharacterId }) => ({
    system: [
      "You decide what a reader's choice changed about a story, and record it.",
      '',
      'You are not writing prose for the reader. You are updating a canonical record.',
      '',
      'Rules:',
      '- The reader chose this deliberately. Ask what is true now that was not true',
      '  before, and record it. Something usually is.',
      '- Saying a thing out loud is itself a thing that happened. An offer made, a plan',
      '  proposed, a feeling admitted — all of these change the story even when nobody',
      '  has answered yet. Write what was done, by whoever did it.',
      '- What the narration below already shows is established, and recording it is not',
      '  inventing it. If someone replied, refused, went quiet, or brought up something',
      '  of their own, that happened — write it down.',
      '- Do not invent what neither the choice nor the narration established. Nothing',
      '  was agreed or settled beyond what they say. Record the smaller true thing',
      '  rather than the larger invented one.',
      '- Choose the kind of mark that fits:',
      '    a beat, when something happened the story must account for;',
      '    background, when the choice revealed something already true;',
      '    a relationship state, when it changed how two people stand.',
      '- A relationship state must accompany a beat. It records what that beat changed,',
      '  so one returned without any event cannot be stored and will be dropped.',
      '- Asking for information is not itself a beat. A question changes the story',
      '  only when the answer does, and the answer is not yours to invent — so record',
      '  nothing unless the asking itself commits the reader to something.',
      '- Returning nothing at all is still right when the choice genuinely only',
      '  continued what was already happening.',
      '- Name the person who acted, and do not default to the reader. A record in',
      '  which every beat is the reader doing something teaches every later turn that',
      '  nobody else ever does anything, and the story stops moving. When the other',
      '  person is the one who moved the scene, the beat is theirs.',
      '- Only reference character and relationship ids that appear below.',
      ...(partnerCharacterId ? PARTNER_RULES : []),
    ].join('\n'),

    ...joinLines([
      `# ${storyline.storyline.title}`,
      '',
      '## Cast',
      ...storyline.characters.map(
        (c) =>
          `- ${shortId(c.id)} — ${c.name}${c.isSelf ? ' (the reader)' : ''}, ${c.role}${c.pronouns ? ` (${PRONOUN_LABELS[c.pronouns]})` : ''}`
      ),
      '',
      '## Relationships',
      // What the reader's relationships mean, so a state recorded for a crush
      // never reads as an ex's ("still wants you back").
      ...storyline.relationships.map((r) => {
        const meaning = relationshipToReader(storyline, r);
        return [
          `- ${shortId(r.id)} — ${nameOf(storyline, r.characterAId)} and ${nameOf(storyline, r.characterBId)}${r.relationshipType ? ` (${r.relationshipType})` : ''}`,
          ...(meaning ? [`  ${meaning}`] : []),
        ].join('\n');
      }),
      '',
      // The cast and relationships are the storyline's, not the playthrough's,
      // so they repeat on every decision; the timeline after them grows.
      CACHE_BREAK,
      '## Timeline',
      ...withBreaks(
        renderTimeline(storyline.timeline),
        steppedBreaks(stableBeats(storyline, playheadOrder))
      ),
      '',
      '## The decision',
      decision.headline,
      ...decision.surfaceLines,
      decision.narrativeContent,
      '',
      `They chose: ${decision.chosenLabel}${decision.chosenDescription ? ` (${decision.chosenDescription})` : ''}`,
      decision.rejectedLabels.length
        ? `They passed over: ${decision.rejectedLabels.join('; ')}`
        : null,
      '',
      ...(partnerCharacterId
        ? [
            `The other player is ${shortId(partnerCharacterId)} (${nameOf(storyline, partnerCharacterId)}).`,
            '',
          ]
        : []),
      'Record what changed.',
    ] satisfies PromptLine[]),
  }),
};

/**
 * How many of the timeline's beats the next decision's prompt will render the
 * same way: those up to the playhead, where this decision's beats are inserted,
 * and none inside the stakes window at the end, whose lines change as it moves.
 */
function stableBeats(storyline: StorylineContext, playheadOrder: number): number {
  const ahead = storyline.timeline.findIndex((beat) => beat.narrativeOrder > playheadOrder);
  const reached = ahead === -1 ? storyline.timeline.length : ahead;
  return Math.min(reached, storyline.timeline.length - STAKES_WINDOW);
}

/** The consequence step on one side of a story for two (`partnerCharacterId` set). */
export const duetConsequencePrompt: PromptSpec<ConsequenceVars, DuetConsequenceOutput> = {
  ...(consequencePrompt as unknown as PromptSpec<ConsequenceVars, DuetConsequenceOutput>),
  name: 'consequence.duet',
  schema: duetConsequenceOutputSchema,
};

function nameOf(storyline: StorylineContext, characterId: string): string {
  return storyline.characters.find((c) => c.id === characterId)?.name ?? 'someone';
}
