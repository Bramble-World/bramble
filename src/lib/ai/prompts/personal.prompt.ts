import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { personalTemplateSchema, type StoryTemplate } from '@/lib/pool/template';
import type { ChatGPTContext } from '@/lib/chatgpt/context';
import { DECLINE_CODES, QUALITY_BAR } from './pool.prompt';
import { ENGAGEMENT_RUBRIC } from './timeline';

/**
 * The two prompts that write a story for one player from what ChatGPT sent
 * (`write_my_story`): a real situation in their life and the people in it.
 *
 * Unlike the pool, this story is played only by the person whose life it is,
 * so the people keep their names (the user's call, 2026-11-18). Because they
 * are real, the story never has them do anything the player didn't say they
 * did that would hurt them if it were read about them. Quality over quantity,
 * as in the pool: the writer may decline, and the check scores what it wrote.
 *
 * The context goes to the model and nowhere else (invariants.md §1).
 */

function contextBlock(context: ChatGPTContext): string[] {
  return [
    'What they shared, between the lines:',
    '---',
    context.about,
    '',
    'The people in it:',
    ...context.people.map(
      (p) => `- ${p.name}, ${p.relationship}${p.details ? `: ${p.details}` : ''}`
    ),
    ...(context.you ? ['', `Who they are: ${context.you}`] : []),
    '---',
  ];
}

export const personalRewriteOutputSchema = z.object({
  verdict: z
    .enum(['story', 'declined'])
    .describe('declined whenever what they shared cannot carry a story worth playing.'),
  declineCode: z
    .enum(DECLINE_CODES)
    .nullable()
    .describe('Why it was declined. Null when verdict is story.'),
  story: personalTemplateSchema.nullable().describe('The story. Null when declined.'),
});

export type PersonalRewriteOutput = z.infer<typeof personalRewriteOutputSchema>;

export const personalRewritePrompt: PromptSpec<
  { context: ChatGPTContext; targetBeats: number },
  PersonalRewriteOutput
> = {
  name: 'personal.rewrite',
  stage: 'pool',
  schema: personalRewriteOutputSchema,

  render: ({ context, targetBeats }) => ({
    system: [
      "You turn a real, unresolved situation in someone's life into the premise of",
      'an interactive story that they will play themselves, as a way to live it',
      'out differently.',
      '',
      'The game: the player is "you", the protagonist. A story is about',
      `${targetBeats} beats long. Each beat ends on a choice, and the choices`,
      'decide how it ends. People text you, call you, turn up. The story is',
      'written beat by beat by another model from what you write here.',
      '',
      'Write the premise, not the story. Who you are, who else is in it (the',
      'people they named), what has already happened, what everyone wants, and',
      "what is unresolved. Leave the ending open: it belongs to the player's",
      'choices.',
      '',
      'The people are real:',
      '- Keep their names and who they are to the player, exactly as given.',
      '- Keep the situation and the feeling. Do not quote what they shared; write',
      '  it in your own words.',
      '- Never have a named person do anything sexual, criminal, violent or',
      '  humiliating, or reveal anything about them, that the player did not say.',
      '  The tension comes from what is unsaid and undecided, not from inventing',
      '  worse things about real people.',
      '',
      'Quality over quantity:',
      '- Decline whenever it cannot carry a story with real stakes and real',
      '  choices. Do not pad a thin situation into a generic story.',
      '- too_thin: there is not enough here.',
      '- not_a_story: there is no situation, person or choice to build on.',
      '- unclear: you cannot tell what they meant.',
      '- Never write a story about minors in danger or anything sexual involving',
      '  them, abuse, or self-harm. Decline those as not_a_story.',
      '',
      'Who plays: mostly teens and people in their early twenties. The stakes are',
      'emotional and social: friendships, crushes, family, school, first jobs.',
      'Nothing sexual, no drinking or drugs as fun.',
      '',
      'The story, when you write one:',
      '- Specific beats generic: a particular night, a particular thing left',
      '  unsaid.',
      '- Everyone else wants something of their own, so they can start things',
      '  rather than only answer you.',
      '- The opening is two or three things that have already happened, oldest',
      '  first; the last one is now, the moment the story begins.',
      '- Lowercase title. Write to the player as "you".',
      '- The hook is one line for a "next story" card: the setting and the',
      '  situation, nothing that happens. The opening lines are three short lines',
      '  from the opening, shown one at a time before play; the last is the',
      '  moment the story begins. The hook must not give away what the opening',
      '  lines reveal, and the lines must reveal nothing past that moment.',
      '',
      ENGAGEMENT_RUBRIC,
    ].join('\n'),
    prompt: contextBlock(context).join('\n'),
  }),
};

export const PERSONAL_REJECT_CODES = [
  'harms_real_person',
  'minors',
  'abuse',
  'self_harm',
  'quotes_answer',
  'spoils_opening',
] as const;

export { QUALITY_BAR };

export const personalCheckOutputSchema = z.object({
  verdict: z.enum(['pass', 'reject']),
  rejectCode: z
    .enum(PERSONAL_REJECT_CODES)
    .nullable()
    .describe('The first rule broken. Null when verdict is pass.'),
  qualityScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('How good a story this is to play, 1-5, against the rubric. Always given.'),
});

export type PersonalCheckOutput = z.infer<typeof personalCheckOutputSchema>;

export const personalCheckPrompt: PromptSpec<
  { context: ChatGPTContext; story: StoryTemplate },
  PersonalCheckOutput
> = {
  name: 'personal.check',
  stage: 'pool',
  schema: personalCheckOutputSchema,

  render: ({ context, story }) => ({
    system: [
      'You check a story premise before its player is given it. It was written',
      'from a real situation in their life, which you are shown, and it names',
      'real people. Only that player will read it.',
      '',
      'Reject it, with the first rule it breaks, if:',
      '- harms_real_person: a named person does anything sexual, criminal,',
      '  violent or humiliating, or has anything revealed about them, that the',
      '  player did not say.',
      '- quotes_answer: it copies sentences from what they shared.',
      '- minors: a minor is in danger, or in anything sexual.',
      '- abuse: it is about abuse.',
      '- self_harm: it is about self-harm or suicide.',
      '- spoils_opening: the hook gives away what the opening lines reveal, or',
      '  the opening lines give away anything past the moment the story begins.',
      'Otherwise pass it. Keeping the real names is expected, not a fault.',
      '',
      'Then score it 1-5 as a story to play, whatever the verdict:',
      '- 5: a specific premise, a want with real stakes, people who want things',
      '  of their own, room for choices to matter, an ending it could reach.',
      '- 4: all of that, with one of them weaker.',
      '- 3: playable but generic.',
      '- 2: thin, or with nothing to decide.',
      '- 1: not a story.',
      'Be strict. Only 4 and 5 are played.',
    ].join('\n'),
    prompt: [
      ...contextBlock(context),
      '',
      'The story premise written from it:',
      JSON.stringify(story, null, 2),
    ].join('\n'),
  }),
};
