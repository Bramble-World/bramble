import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { storyTemplateSchema, type StoryTemplate } from '@/lib/pool/template';
import { ENGAGEMENT_RUBRIC } from './timeline';

/**
 * The two prompts that fill the pool from reborn answers.
 *
 * The answer is a player's own past, typed in 140 characters. It goes to the
 * model and nowhere else: it is never logged, never in an error, and the story
 * written from it never quotes it (invariants.md §1). Quality over quantity —
 * the writer may decline, and the check scores what it wrote, so a thin answer
 * becomes no story rather than a generic one.
 */

/** What each of the three questions asked, so the model knows what it is reading. */
export const REBORN_QUESTIONS: Record<1 | 2 | 3, string> = {
  1: 'a choice from your last life you still wonder about',
  2: 'someone who changed your last life',
  3: 'what you were about to do when your last life ended',
};

/** How question 2's role chip reads in a prompt. */
const ROLE_LABELS: Record<string, string> = {
  parent: 'a parent',
  ex: 'an ex',
  best_friend: 'a best friend',
  teacher: 'a teacher',
  boss: 'a boss',
  stranger: 'a stranger',
};

export type PoolAnswer = { question: 1 | 2 | 3; role: string | null; text: string };

function answerBlock(answer: PoolAnswer): string[] {
  return [
    `They were asked for ${REBORN_QUESTIONS[answer.question]}.`,
    ...(answer.role ? [`They said it was ${ROLE_LABELS[answer.role] ?? 'someone'}.`] : []),
    'Their answer, between the lines:',
    '---',
    answer.text,
    '---',
  ];
}

export const DECLINE_CODES = ['too_thin', 'not_a_story', 'unclear'] as const;

export const rewriteOutputSchema = z.object({
  verdict: z
    .enum(['story', 'declined'])
    .describe('declined whenever the answer cannot carry a story worth playing.'),
  declineCode: z
    .enum(DECLINE_CODES)
    .nullable()
    .describe('Why it was declined. Null when verdict is story.'),
  story: storyTemplateSchema.nullable().describe('The story. Null when declined.'),
});

export type RewriteOutput = z.infer<typeof rewriteOutputSchema>;

export const rewritePrompt: PromptSpec<{ answer: PoolAnswer; targetBeats: number }, RewriteOutput> =
  {
    name: 'pool.rewrite',
    stage: 'pool',
    schema: rewriteOutputSchema,

    render: ({ answer, targetBeats }) => ({
      system: [
        "You turn one sentence from a stranger's past into the premise of an",
        'interactive story that someone else will play.',
        '',
        'The game: the player is "you", the protagonist. A story is about',
        `${targetBeats} beats long. Each beat ends on a choice, and the choices`,
        'decide how it ends. People text you, call you, turn up. The story is',
        'written beat by beat by another model from what you write here.',
        '',
        'Write the premise, not the story. Who you are, who else is in it (one to',
        'three people), what has already happened, what everyone wants, and what',
        "is unresolved. Leave the ending open: it belongs to the player's choices.",
        '',
        'Privacy, which comes first:',
        '- Nobody who reads this story may be able to tell whose past it was.',
        '- Replace every name, place, school, employer, team, street, date and',
        '  any other detail that could identify someone. Invent new ones.',
        '- Never quote the answer, or keep any phrase from it. Take the situation',
        '  and the feeling; leave the words.',
        '- Move it if that helps: another city, another job, another decade.',
        '',
        'Quality over quantity:',
        '- Decline whenever the answer cannot carry a story with real stakes and',
        '  real choices. Do not pad a thin answer into a generic story — a story',
        '  anyone could have written is worse than none.',
        '- too_thin: there is not enough here (a word, a joke, "idk").',
        '- not_a_story: there is no situation, person or choice to build on.',
        '- unclear: you cannot tell what they meant.',
        '- Never write a story about minors in danger, abuse, or self-harm. Decline',
        '  those as not_a_story.',
        '',
        'The story, when you write one:',
        '- Specific beats generic: a particular person, a particular night, a',
        '  particular thing left unsaid.',
        '- Everyone else wants something of their own, so they can start things',
        '  rather than only answer you.',
        '- The opening is two or three things that have already happened, oldest',
        '  first; the last one is now, the moment the story begins.',
        '- Lowercase title. Write to the player as "you".',
        '',
        ENGAGEMENT_RUBRIC,
      ].join('\n'),
      prompt: answerBlock(answer).join('\n'),
    }),
  };

export const CHECK_REJECT_CODES = [
  'identifier',
  'minors',
  'abuse',
  'self_harm',
  'quotes_answer',
] as const;

/** Only a story the check scores at least this high goes into the pool. */
export const QUALITY_BAR = 4;

export const checkOutputSchema = z.object({
  verdict: z.enum(['pass', 'reject']),
  rejectCode: z
    .enum(CHECK_REJECT_CODES)
    .nullable()
    .describe('The first rule broken. Null when verdict is pass.'),
  qualityScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('How good a story this is to play, 1-5, against the rubric. Always given.'),
});

export type CheckOutput = z.infer<typeof checkOutputSchema>;

export const checkPrompt: PromptSpec<{ answer: PoolAnswer; story: StoryTemplate }, CheckOutput> = {
  name: 'pool.check',
  stage: 'pool',
  schema: checkOutputSchema,

  render: ({ answer, story }) => ({
    system: [
      'You check a story premise before strangers are given it to play. It was',
      "written from one sentence of a real person's past, which you are shown.",
      '',
      'Reject it, with the first rule it breaks, if:',
      '- identifier: any name, place, school, employer or other detail from the',
      '  answer survives, or anything that would let someone who knows the',
      '  author recognise them.',
      '- quotes_answer: it keeps any phrase from the answer.',
      '- minors: a minor is in danger, or in anything sexual.',
      '- abuse: it is about abuse.',
      '- self_harm: it is about self-harm or suicide.',
      'Otherwise pass it.',
      '',
      'Then score it 1-5 as a story to play, whatever the verdict:',
      '- 5: a specific premise, a want with real stakes, people who want things',
      '  of their own, room for choices to matter, an ending it could reach.',
      '- 4: all of that, with one of them weaker.',
      '- 3: playable but generic — a story anyone could have written.',
      '- 2: thin, or with nothing to decide.',
      '- 1: not a story.',
      'Be strict. Only 4 and 5 are played.',
    ].join('\n'),
    prompt: [
      ...answerBlock(answer),
      '',
      'The story premise written from it:',
      JSON.stringify(story, null, 2),
    ].join('\n'),
  }),
};
