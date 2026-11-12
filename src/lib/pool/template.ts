import { z } from 'zod';

/**
 * A story in the shared pool, before it is anyone's.
 *
 * Every storyline, character and person belongs to one player, and that is the
 * whole tenancy guarantee (invariants.md §3). So the pool does not hold
 * storylines: it holds these, and a template is copied into the player's own
 * rows when it is assigned (`instantiateTemplate`). Nothing in a copy points
 * back at the author.
 *
 * The same shape is what the rewrite prompt writes, and what a seed file holds,
 * so a seed can never be anything a generated story could not.
 *
 * Nullable rather than optional, for structured output; see turn.prompt.ts.
 */

export const TEMPLATE_PRONOUNS = ['he', 'she', 'they'] as const;

const castMemberSchema = z.object({
  name: z.string().min(1).max(40).describe('A first name, invented. Never a name from the source.'),
  pronouns: z.enum(TEMPLATE_PRONOUNS),
  relationshipType: z
    .string()
    .min(1)
    .max(40)
    .describe('Who they are to you, in two or three words: "your older sister", "your ex".'),
  role: z.enum(['supporting', 'antagonist']),
  description: z
    .string()
    .min(1)
    .describe('One or two sentences: who they are, as the story needs.'),
  want: z.string().min(1).describe('What they are after in this story.'),
  avoids: z.string().min(1).describe('What they will not do or say, or are hiding.'),
  voiceTone: z.string().nullable().describe('How they talk, briefly. Null if unremarkable.'),
  closeness: z.string().nullable().describe('How close you two are when the story starts.'),
  tension: z.string().nullable().describe('What is unresolved between you when it starts.'),
});

export const storyTemplateSchema = z.object({
  title: z.string().min(1).max(60).describe('Lowercase, a few words: "the night before".'),
  premise: z
    .string()
    .min(1)
    .max(280)
    .describe('One or two sentences on what this story is about and what is at stake.'),
  setting: z.string().min(1).describe('Where and when, in a sentence. Invented, never the source.'),
  tone: z.string().min(1).describe('The register to play it in: "tender and a little absurd".'),
  self: z.object({
    description: z.string().min(1).describe('Who "you" are in this story, in a sentence or two.'),
    want: z.string().min(1),
    avoids: z.string().min(1),
  }),
  cast: z.array(castMemberSchema).min(1).max(3),
  opening: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        description: z.string().min(1).describe('What happened, in a sentence or two.'),
        engagementScore: z.number().int().min(1).max(10),
      })
    )
    .min(2)
    .max(3)
    .describe('What has already happened when the story starts, oldest first. The last is now.'),
  background: z
    .array(z.string().min(1))
    .max(6)
    .describe('Things that are true and shape the story, but are never stated outright.'),
});

export type StoryTemplate = z.infer<typeof storyTemplateSchema>;

/**
 * Every piece of a template's text, in one string.
 *
 * What the moderation check reads, and what the tests search for words from an
 * answer. A field added to the schema and left out here would be the one field
 * nothing checks, so it walks the parsed value rather than naming fields.
 */
export function templateText(template: StoryTemplate): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(template);
  return parts.join('\n');
}
