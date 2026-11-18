import { z } from 'zod';

/**
 * What `write_my_story` takes from ChatGPT: a real situation in its user's life,
 * the people in it, and who the user is.
 *
 * ChatGPT fills this from what it knows about them, shows them what it will
 * send, and sends it once they say so. The limits are the minimum a story needs
 * (Apps SDK: collect only what the app needs), and the descriptions are what
 * ChatGPT reads, so they say what to leave out as well as what to send.
 */

export const CONTEXT_ABOUT_MAX_CHARS = 2000;
export const CONTEXT_DETAIL_MAX_CHARS = 300;
export const CONTEXT_MAX_PEOPLE = 3;

export const contextPersonSchema = z.object({
  name: z.string().trim().min(1).max(40).describe('Their first name, as the user calls them.'),
  relationship: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe('Who they are to the user, in a few words: "best friend", "ex", "older sister".'),
  details: z
    .string()
    .trim()
    .max(CONTEXT_DETAIL_MAX_CHARS)
    .describe('What the story needs to know about them, in a sentence or two.'),
});

export const chatgptContextShape = {
  about: z
    .string()
    .trim()
    .min(1)
    .max(CONTEXT_ABOUT_MAX_CHARS)
    .describe(
      "A real situation in the user's life that is still unresolved, in one to three short paragraphs: what happened, what they want, what they are avoiding. Only what the story needs."
    ),
  people: z
    .array(contextPersonSchema)
    .min(1)
    .max(CONTEXT_MAX_PEOPLE)
    .describe('The one to three people the situation is about.'),
  you: z
    .string()
    .trim()
    .max(CONTEXT_DETAIL_MAX_CHARS)
    .nullable()
    .optional()
    .describe(
      'Who the user is, in a sentence: age range, school or work, what matters to them. Null if not needed.'
    ),
};

export const chatgptContextSchema = z.object(chatgptContextShape);

export type ChatGPTContext = z.infer<typeof chatgptContextSchema>;

/** Everything in a context, in one string: what moderation reads. */
export function contextText(context: ChatGPTContext): string {
  return [
    context.about,
    ...context.people.map((p) => `${p.name}, ${p.relationship}: ${p.details}`),
    context.you ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}
