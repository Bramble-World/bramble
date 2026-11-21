import { z } from 'zod';
import { PromptSpec } from '../prompt';
import type { SessionContext } from '@/lib/services/generation/generation.types';

/**
 * The ending page: how a finished story went, written once after its last beat.
 *
 * Shown only this playthrough — the beats the reader lived and the choices they
 * made — and never the storyline's timeline or arc summary, so it can describe
 * nothing they haven't reached. That is what lets it be returned when the arc
 * summary never is.
 */

export type EndingVars = {
  title: string;
  tone: string | null;
  /** Everyone the reader met, by name. */
  people: string[];
  /**
   * What the people the reader picked on the naming screen are to them ("Mae is
   * your crush: you have never been together…"), so the ending page doesn't
   * write a crush as an ex. From `relationshipToReader`; empty for the rest.
   */
  toYou: string[];
  session: SessionContext;
};

export const endingOutputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(60)
    .describe('The ending\'s own name, lowercase, a few words: "the train home".'),
  summary: z
    .string()
    .min(1)
    .max(320)
    .describe('Exactly two sentences, lowercase, to "you": how it ended and what it cost or gave.'),
  keyChoices: z
    .array(
      z.object({
        beat: z.number().int().min(1).describe('The number of the beat the choice was made on.'),
        label: z
          .string()
          .min(1)
          .max(70)
          .describe('What was chosen, re-worded as "you …", lowercase, past tense.'),
      })
    )
    .min(1)
    .max(3)
    .describe('The three choices that most decided how it ended, in story order.'),
  storyNights: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('How many nights the story spanned, from its clock and dates. Null if unclear.'),
});

export type EndingOutput = z.infer<typeof endingOutputSchema>;

export const endingPrompt: PromptSpec<EndingVars, EndingOutput> = {
  name: 'ending.summarise',
  stage: 'consequence',
  schema: endingOutputSchema,

  render: ({ title, tone, people, toYou, session }) => ({
    system: [
      'A story has just ended. Write its ending page.',
      '',
      'Rules:',
      '- Describe only what happened in the beats below. Nothing else is true yet,',
      '  and nothing after the last beat happened.',
      '- Write to the reader as "you", lowercase, plainly. No moral, no "and so".',
      '- The title names this ending, not the story: what it came to.',
      '- Two sentences for the summary: how it ended, then what it cost or gave.',
      "- Key choices: the three of the reader's own choices that most decided the",
      '  ending, by the number in its "### Beat N" heading, each re-worded as "you …"',
      '  — "you texted back at 1:48 am", not "Text back". Only numbered beats have a',
      '  choice; the last beat has none, and no number.',
      '- Count story nights from the clock times and dates on the beats. Null if',
      '  you cannot tell.',
    ].join('\n'),
    prompt: [
      `# ${title}`,
      tone ? `Register: ${tone}` : null,
      people.length ? `People: ${people.join(', ')}` : null,
      ...toYou,
      '',
      '## The playthrough',
      // Numbered by position in the playthrough, which is what the server maps
      // a key choice back through. The last beat (the ending, never answered)
      // has no number, so it can't be named as a choice. Numbered like the
      // others, it invited exactly that: it is the beat that decided the most,
      // and naming it alone threw the whole ending away.
      ...session.turns.map((turn, i) =>
        [
          turn.selectedChoiceLabel ? `### Beat ${i + 1}` : '### The last beat',
          `${turn.headline ? `${turn.headline} ` : ''}${turn.narrativeContent}`,
          ...turn.surfaceLines,
          turn.selectedChoiceLabel
            ? `You chose: ${turn.selectedChoiceLabel}`
            : '(no choice: the story ended here)',
        ].join('\n')
      ),
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }),
};
