import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { StorylineContext } from '@/lib/services/generation/generation.types';

export type ConsequenceVars = {
  storyline: StorylineContext;
  /** What the user was shown, and what they picked. */
  decision: {
    narrativeContent: string;
    chosenLabel: string;
    chosenDescription: string | null;
    rejectedLabels: string[];
  };
};

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
  afterNarrativeOrder: z
    .number()
    .int()
    .describe(
      'The narrativeOrder of the existing beat these consequences follow. Must be one listed in the timeline, or 0 to place them before everything.'
    ),

  events: z
    .array(
      z.object({
        title: z.string().min(1).describe('A short label for the beat, under 60 characters.'),
        description: z.string().min(1).describe('What now happens, 1-3 sentences.'),
        stakes: z.string().nullable().describe('What is at risk. Null if nothing new is.'),
        participantCharacterIds: z
          .array(z.string())
          .describe('Character ids from the cast who are involved. May be empty.'),
        generationRationale: z
          .string()
          .min(1)
          .describe(
            'Why this beat follows from the choice. Your own reasoning — never quote the story text back.'
          ),
      })
    )
    .max(2)
    .describe(
      'At most two new beats. Usually one: the thing the reader just did. Empty only when the choice changed nothing at all.'
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

export const consequencePrompt: PromptSpec<ConsequenceVars, ConsequenceOutput> = {
  name: 'consequence.commit',
  stage: 'consequence',
  schema: consequenceOutputSchema,

  render: ({ storyline, decision }) => ({
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
      '  has answered yet. Write the act, not the outcome.',
      '- Do not invent what the choice did not establish. Nobody agreed, nothing was',
      '  settled and no one replied unless the choice says so. Record the smaller true',
      '  thing rather than the larger invented one.',
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
      '- Place what you add after the beat it follows, using a narrativeOrder from the',
      '  timeline. Consequences belong where the story is, not at the end of it.',
      '- generationRationale is your own reasoning about why the beat follows. Never',
      '  quote or paraphrase the narration back into it.',
      '- Only reference character and relationship ids that appear below.',
    ].join('\n'),

    prompt: [
      `# ${storyline.storyline.title}`,
      '',
      '## Cast',
      ...storyline.characters.map(
        (c) => `- ${c.id} — ${c.name}${c.isSelf ? ' (the reader)' : ''}, ${c.role}`
      ),
      '',
      '## Relationships',
      ...storyline.relationships.map(
        (r) =>
          `- ${r.id} — ${nameOf(storyline, r.characterAId)} and ${nameOf(storyline, r.characterBId)}`
      ),
      '',
      '## Timeline',
      ...storyline.timeline.map((b) => `${b.narrativeOrder}. ${b.title} — ${b.description}`),
      '',
      '## The decision',
      decision.narrativeContent,
      '',
      `They chose: ${decision.chosenLabel}${decision.chosenDescription ? ` (${decision.chosenDescription})` : ''}`,
      decision.rejectedLabels.length
        ? `They passed over: ${decision.rejectedLabels.join('; ')}`
        : null,
      '',
      'Record what changed.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }),
};

function nameOf(storyline: StorylineContext, characterId: string): string {
  return storyline.characters.find((c) => c.id === characterId)?.name ?? 'someone';
}
