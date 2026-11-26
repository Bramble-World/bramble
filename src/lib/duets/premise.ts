import { z } from 'zod';
import { storyTemplateSchema, type StoryTemplate } from '@/lib/pool/template';

/**
 * A duet premise: one setup, two points of view, for two players who know
 * each other (a story for two, `duets`).
 *
 * Each side is a whole story template, the same shape as a pool story, so the
 * rest of the way is a next story's: copied into that player's own rows when
 * they start it. In each side, exactly one cast member is the other player,
 * named `PARTNER` until the invite is accepted; their name can appear in any
 * text of that side too. The two players could be any two friends, so a
 * premise never makes them romantic, and every other person is invented.
 *
 * The model writes more (`duet.write`, kept in `duet_premises`); `seeds/`
 * holds the hand-written ones.
 */
export const PARTNER = '{partner}';

export const duetPremiseSchema = z
  .object({
    /** Side A: the inviter's. */
    a: storyTemplateSchema,
    /** Side B: whoever accepted. */
    b: storyTemplateSchema,
  })
  .refine(
    (premise) => [premise.a, premise.b].every((side) => partnerIndex(side) !== -1),
    'Each side casts the other player exactly once'
  );

export type DuetPremise = z.infer<typeof duetPremiseSchema>;

/** Where the other player is in a side's cast, or -1 unless exactly once. */
export function partnerIndex(side: StoryTemplate): number {
  const at = side.cast.map((member, i) => (member.name === PARTNER ? i : -1)).filter((i) => i >= 0);
  return at.length === 1 ? at[0] : -1;
}

/**
 * A side with the other player's first name in place of `PARTNER`, everywhere
 * it appears, ready to be one player's story. Lowercase in the card's hook and
 * the opening lines, which are written all lowercase.
 */
export function castPartner(side: StoryTemplate, name: string): StoryTemplate {
  const fill =
    (as: string) =>
    (value: unknown): unknown => {
      if (typeof value === 'string') return value.split(PARTNER).join(as);
      if (Array.isArray(value)) return value.map(fill(as));
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fill(as)(v)]));
      }
      return value;
    };
  const lower = name.toLowerCase();
  return storyTemplateSchema.parse({
    ...(fill(name)(side) as StoryTemplate),
    hook: fill(lower)(side.hook),
    openingLines: fill(lower)(side.openingLines),
  });
}

/** Words that make the two players a couple, which a premise never may. */
const ROMANTIC =
  /\b(ex|exes|crush|date|dating|girlfriend|boyfriend|lover|fianc[eé]e?|husband|wife|situationship|hook ?up|kiss)\b|(?<!lab |project |business |dance |study )\bpartner\b/i;

export type PremiseProblem = 'romance' | 'partner_named';

/**
 * What a written premise breaks that the schema can't say, or null. The check
 * model reads for the rest; these are the rules worth not leaving to it.
 */
export function premiseProblem(premise: DuetPremise): PremiseProblem | null {
  for (const side of [premise.a, premise.b]) {
    const partner = side.cast[partnerIndex(side)];
    if (ROMANTIC.test(partner.relationshipType)) return 'romance';
    // Another cast member given the other player's placeholder as part of a name.
    if (side.cast.some((member, i) => i !== partnerIndex(side) && member.name.includes(PARTNER))) {
      return 'partner_named';
    }
  }
  return null;
}

/** The other player is always "they", whatever the writer chose. */
export function withPartnerAsThey(premise: DuetPremise): DuetPremise {
  const side = (template: StoryTemplate): StoryTemplate => ({
    ...template,
    cast: template.cast.map((member) =>
      member.name === PARTNER ? { ...member, pronouns: 'they' as const } : member
    ),
  });
  return { a: side(premise.a), b: side(premise.b) };
}
