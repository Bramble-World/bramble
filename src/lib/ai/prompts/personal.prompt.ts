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
 * did that would hurt them if it were read about them. Unlike the pool, the
 * player asked for this story themselves, so the writer fills small gaps rather
 * than declining (approved 2026-11-19, after the first real request was
 * declined as too thin); the check still scores it against the same bar.
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

/**
 * The rules a story can be rejected for that a second writing can fix, and how
 * the writer is reminded of the one an earlier version broke. Only the code
 * reaches the writer, never the rejected story.
 */
export const FIXABLE_REJECTIONS = ['harms_real_person', 'spoils_opening'] as const;
export type FixableRejection = (typeof FIXABLE_REJECTIONS)[number];

const FIX_REMINDERS: Record<FixableRejection, string> = {
  harms_real_person:
    'An earlier version was turned down because it had a named person do something sexual, criminal, violent or humiliating, or made up something private or damaging about them, that the player did not say. Keep every named person to what the player said, and to ordinary filled-in detail.',
  spoils_opening:
    'An earlier version was turned down because its hook or opening lines gave too much away. The hook names where you are, who is there and the situation you start in, never what happens, what anyone does or decides, or a twist; the opening lines say only what has happened by the moment the story begins.',
};

export const personalRewritePrompt: PromptSpec<
  { context: ChatGPTContext; targetBeats: number; fix?: FixableRejection },
  PersonalRewriteOutput
> = {
  name: 'personal.rewrite',
  stage: 'personal',
  schema: personalRewriteOutputSchema,

  render: ({ context, targetBeats, fix }) => ({
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
      '  humiliating that the player did not say, and never make up anything',
      '  private or damaging about them (a secret, their health, cheating, a',
      '  crime). Ordinary detail you fill in is fine.',
      '  The tension comes from what is unsaid and undecided, not from inventing',
      '  worse things about real people.',
      '',
      'They asked for this story, so write it whenever you can:',
      '- A situation and one person are enough. Fill what is missing (the',
      '  setting, the timeline, what each person wants) with plausible, ordinary',
      '  detail that fits what was given, never with anything the rule above',
      '  forbids about a named person.',
      '- Decline only when there is nothing to build a story on at all:',
      '- too_thin: no situation, only a topic or a feeling.',
      '- not_a_story: nothing that could be unresolved between people.',
      '- unclear: you cannot tell what happened even after a generous reading.',
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
      '- The hook is one line for a "next story" card. It names where you are,',
      '  who is there and the situation you start in. It never says what',
      '  happens next, what anyone does or decides, or a twist.',
      '- The opening lines are three short lines from the opening, shown one at',
      '  a time before play; the last is the moment the story begins. They say',
      '  only what has already happened by then: no line hints at how it turns',
      '  out, what someone will do, or a secret still to come out.',
      '- The hook does not repeat or give away what the opening lines reveal.',
      '  Before you answer, read the hook and the opening lines again against',
      '  these rules.',
      '',
      ENGAGEMENT_RUBRIC,
      ...(fix ? ['', FIX_REMINDERS[fix]] : []),
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
  stage: 'personalCheck',
  schema: personalCheckOutputSchema,

  render: ({ context, story }) => ({
    system: [
      'You check a story premise before its player is given it. It was written',
      'from a real situation in their life, which you are shown, and it names',
      'real people. Only that player will read it.',
      '',
      'Reject it, with the first rule it breaks, if:',
      '- harms_real_person: a named person does anything sexual, criminal,',
      '  violent or humiliating that the player did not say, or the story makes',
      '  up something private or damaging about them (a secret, their health,',
      '  cheating, a crime).',
      '- quotes_answer: it copies sentences from what they shared.',
      '- minors: a minor is in danger, or in anything sexual.',
      '- abuse: it is about abuse.',
      '- self_harm: it is about self-harm or suicide.',
      '- spoils_opening: the hook says what happens in the story (an event, a',
      '  decision, a twist) or gives away what the opening lines reveal, or an',
      '  opening line tells something past the moment the story begins. Naming',
      '  the setting, the people and the situation they start in is not a',
      '  spoiler.',
      'Otherwise pass it. Keeping the real names is expected, not a fault, and so',
      'is ordinary detail the writer was asked to fill in: the setting, the',
      'timeline, what someone wants or feels, where they are or are going.',
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
