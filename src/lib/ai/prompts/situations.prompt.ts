import { z } from 'zod';
import { PromptSpec } from '../prompt';

/**
 * Sorts what a link from ChatGPT carried into the situations Bramble will
 * write stories from (`POST /api/v1/stories/from-chatgpt`).
 *
 * ChatGPT is asked to put up to five situations from its user's life in the
 * link, but nothing holds it to what it was asked: the link is one piece of
 * text it wrote. So this step decides for itself what is a story and what is
 * not, and drops whatever it shouldn't keep, whatever ChatGPT sent. Only what
 * it returns is kept (`chatgpt_contexts`); the text itself is never stored.
 *
 * Each situation it keeps is written up as `write_my_story` would have sent it
 * (`ChatGPTContext`), so the rest of the way is exactly that tool's: moderated,
 * queued, written by `personal.rewrite`, checked by `personal.check`.
 *
 * The text goes to the model and nowhere else (invariants.md §1).
 */

/** The most situations one link can make stories from. */
export const MAX_LINK_SITUATIONS = 5;

/**
 * Why a situation in the note wasn't kept, as a code: logged and counted, so
 * links that make nothing can be told apart (the user's call, 2026-11-26),
 * never anything from the note itself.
 */
export const SKIP_REASONS = [
  'health',
  'mental_health',
  'money_or_legal',
  'identifying',
  'logistics',
  'sexual',
  'religion_or_sexuality',
  'too_thin',
  'repeat',
  'other',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Loose on purpose: lengths are checked after the call against
 * `chatgptContextSchema`, and a situation that doesn't fit is dropped, rather
 * than failing every situation in the link over one long paragraph.
 */
export const situationsOutputSchema = z.object({
  situations: z
    .array(
      z.object({
        about: z
          .string()
          .describe(
            'The situation in one to three short paragraphs, in your own words: what happened, what is at stake, what is still unresolved.'
          ),
        people: z
          .array(
            z.object({
              name: z.string().describe('Their first name, as given.'),
              relationship: z
                .string()
                .describe('Who they are to the user, in a few words: "ex", "best friend".'),
              details: z
                .string()
                .describe('What the story needs to know about them, in a sentence or two.'),
            })
          )
          .describe('The one to three people the situation is about.'),
        you: z
          .string()
          .nullable()
          .describe('Who the user is, in a sentence, if the text says. Null otherwise.'),
      })
    )
    .describe(
      `The situations to write stories from, at most ${MAX_LINK_SITUATIONS}, best first. Empty when none is worth a story.`
    ),
  // After the situations, so what's kept is written first. Codes only.
  skipped: z
    .array(z.enum(SKIP_REASONS))
    .describe(
      'One code for each situation in the note that you did not keep, saying why. Empty when you kept them all.'
    ),
});

export type SituationsOutput = z.infer<typeof situationsOutputSchema>;

export const situationsPrompt: PromptSpec<{ text: string }, SituationsOutput> = {
  name: 'chatgpt.situations',
  stage: 'situations',
  schema: situationsOutputSchema,

  render: ({ text }) => ({
    system: [
      "You read a note ChatGPT wrote about situations in someone's life, and pick",
      'out the ones that could each become an interactive story they will play',
      'themselves, as a way to live it out differently.',
      '',
      `Return at most ${MAX_LINK_SITUATIONS} situations, best first. Each is one`,
      'situation between real people: what happened, what is at stake, and what is',
      'still unresolved, with the one to three people in it.',
      '',
      'Keep: crushes, exes, fights, secrets, rivalries, friend and family drama,',
      'big decisions about people. Something still undecided between people.',
      '',
      'Drop, whatever the note says, and never mention it in what you keep:',
      '- health of any kind: illness, symptoms, injuries, medical care,',
      '  medication, sexual health (such as STIs), pregnancy, eating;',
      '- mental-health crises, self-harm or suicide, abuse, someone in danger;',
      '- money and debt; legal trouble, police, immigration;',
      '- anything that identifies someone or where they are: surnames,',
      '  addresses, phone numbers, emails, schools or employers by name, IDs;',
      '- work or school logistics with nothing unresolved between people:',
      '  deadlines, schedules, applications, tasks;',
      '- anything sexual, and anything at all sexual involving a minor;',
      '- religion and sexuality, unless the note makes clear the user wants them in;',
      '- anything too thin to play: a topic, a mood or a single fact with no',
      '  situation behind it.',
      'If a situation is worth keeping but carries one of these, keep it only if',
      'the story stands without that detail, and leave the detail out.',
      '',
      'The people are real:',
      '- Keep their first names and who they are to the user, exactly as given.',
      '  Never invent a name; a situation with no one named is too thin.',
      '- Say only what the note says about them. Never add anything they did.',
      '',
      'Write in your own words, plainly, about "the user". Keep each situation',
      'separate: one per entry, and never the same one twice. Return an empty list',
      'when nothing is worth a story.',
      '',
      'For every situation in the note you leave out, add one code to skipped saying',
      'why: health, mental_health, money_or_legal, identifying, logistics, sexual,',
      'religion_or_sexuality, too_thin, repeat (the same as one kept) or other.',
    ].join('\n'),
    prompt: ['The note, between the lines:', '---', text, '---'].join('\n'),
  }),
};
