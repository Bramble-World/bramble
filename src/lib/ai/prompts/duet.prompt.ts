import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { storyTemplateSchema } from '@/lib/pool/template';
import { PARTNER, type DuetPremise } from '@/lib/duets/premise';
import { ENGAGEMENT_RUBRIC } from './timeline';

/**
 * Writing and checking duet premises: one setup played from two sides by two
 * players who know each other (a story for two). Nobody's past is in them, so
 * they're invented whole, and the only person in them who is real is the
 * other player, written as a placeholder until an invite is accepted.
 */

/** Who the two players are to each other, one picked per premise so the stock varies. */
export const PAIRINGS = [
  'best friends',
  'siblings',
  'cousins',
  'roommates',
  'teammates',
  'lab partners',
  'coworkers at a summer job',
  'friends from the same group chat',
  'old friends who drifted apart',
  'neighbours who grew up together',
] as const;

export const duetWriteOutputSchema = z.object({
  a: storyTemplateSchema.describe('Side A: the player who sent the invite.'),
  b: storyTemplateSchema.describe('Side B: the player who accepted it.'),
});

export type DuetWriteOutput = z.infer<typeof duetWriteOutputSchema>;

export type DuetWriteVars = {
  pairing: (typeof PAIRINGS)[number];
  /** Premises already in stock, title and setting, so this one is different. */
  existing: { title: string; setting: string }[];
};

export const duetWritePrompt: PromptSpec<DuetWriteVars, DuetWriteOutput> = {
  name: 'duet.write',
  stage: 'pool',
  schema: duetWriteOutputSchema,

  render: ({ pairing, existing }) => ({
    system: [
      'You write the premise of an interactive story played by two real people at',
      'once, each from their own side. Each is "you" in their own story, and the',
      'other is a character in it. They play at their own pace; what one does can',
      'reach the other later.',
      '',
      'Write one shared setup and two sides:',
      '- Side A is the person who sent the invite, side B who accepted. Each side',
      '  is a whole premise: who you are, who else is in it (one to three people),',
      '  what has already happened, what everyone wants, what is unresolved.',
      `- In each side, exactly one cast member is the other player. Their name is`,
      `  exactly ${PARTNER}, and it may appear in any text of that side. Never give`,
      '  them a name, a gender or a look: their pronouns are "they".',
      '- The two sides are the same events from two points of view, and each one',
      '  knows something the other does not. Each must be playable on its own,',
      '  without the other side ever being played.',
      '- Any other people are invented and the same people on both sides.',
      '',
      'The two players:',
      `- They are ${pairing}, aged 16 to 24. Never romantic or sexual with each`,
      '  other: no crush, ex, dating, kiss or tension of that kind between them.',
      '- Nothing about them that one of them could find hurtful about themselves:',
      '  no looks, weight, health, money or family trouble.',
      '',
      'Safety, always: no minors in danger or in anything sexual, no abuse, no',
      'self-harm or suicide, no drugs, no real people, brands, schools or places.',
      '',
      'Each side, like any story here:',
      '- Specific beats generic: a particular night, a particular thing unsaid.',
      '- The opening is two or three things that have already happened, oldest',
      '  first; the last one is now, the moment the story begins.',
      '- Lowercase title, the same on both sides. Write to the player as "you".',
      '- The hook is one line for a "next story" card: the setting and the',
      '  situation, nothing that happens. The opening lines are three short',
      '  lowercase lines, shown one at a time before play; the last is the moment',
      '  the story begins. They give away nothing past that moment.',
      '',
      ENGAGEMENT_RUBRIC,
    ].join('\n'),
    prompt: existing.length
      ? [
          'Already written, so make this one different in setting and situation:',
          ...existing.map((p) => `- ${p.title}: ${p.setting}`),
        ].join('\n')
      : 'Write the first one.',
  }),
};

export const DUET_REJECT_CODES = [
  'romance',
  'sexual',
  'minors',
  'abuse',
  'self_harm',
  'hurtful',
  'real_people',
  'one_sided',
  'spoils_opening',
] as const;

/** Only a premise the check scores at least this high is offered. */
export const DUET_QUALITY_BAR = 4;

export const duetCheckOutputSchema = z.object({
  verdict: z.enum(['pass', 'reject']),
  rejectCode: z
    .enum(DUET_REJECT_CODES)
    .nullable()
    .describe('The first rule broken. Null when verdict is pass.'),
  qualityScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('How good a story for two this is to play, 1-5. Always given.'),
});

export type DuetCheckOutput = z.infer<typeof duetCheckOutputSchema>;

export const duetCheckPrompt: PromptSpec<{ premise: DuetPremise }, DuetCheckOutput> = {
  name: 'duet.check',
  stage: 'pool',
  schema: duetCheckOutputSchema,

  render: ({ premise }) => ({
    system: [
      'You check the premise of a story two real people will play together, each',
      `from their own side, before anyone is given it. ${PARTNER} stands for the`,
      'other player.',
      '',
      'Reject it, with the first rule it breaks, if:',
      '- romance: the two players are romantic or sexual with each other in any',
      '  way, or anything between them reads that way.',
      '- sexual: anything sexual at all.',
      '- minors: a minor is in danger.',
      '- abuse: it is about abuse.',
      '- self_harm: it is about self-harm or suicide.',
      '- hurtful: it says something about the other player one of them could be',
      '  hurt by: their looks, weight, health, money or family.',
      '- real_people: a real person, brand, school or place.',
      '- one_sided: either side cannot be played without the other, or the two',
      '  sides are not the same events from two points of view.',
      '- spoils_opening: a hook gives away what its opening lines reveal, or the',
      '  opening lines give away anything past the moment the story begins.',
      'Otherwise pass it.',
      '',
      'Then score it 1-5 as a story for two, whatever the verdict:',
      '- 5: specific, real stakes on both sides, each side knows something the',
      '  other does not, and what one does could matter to the other.',
      '- 4: all of that, with one of them weaker.',
      '- 3: playable but generic.',
      '- 2: thin, or one side has nothing to decide.',
      '- 1: not a story.',
      'Be strict. Only 4 and 5 are played.',
    ].join('\n'),
    prompt: JSON.stringify(premise, null, 2),
  }),
};
