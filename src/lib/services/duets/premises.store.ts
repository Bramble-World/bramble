import { eq } from 'drizzle-orm';
import { duetPremises } from '@/db/schema/tables';
import { duetPremiseSchema, type DuetPremise } from '@/lib/duets/premise';
import { DUET_PREMISES } from '@/lib/duets/seeds';
import type { Executor } from '../executor';

/**
 * Every duet premise that can be given to a pair: the hand-written seeds and
 * the written ones still `ready` in `duet_premises`, by slug.
 */
export async function premiseSlugs(tx: Executor): Promise<string[]> {
  const rows = await tx
    .select({ slug: duetPremises.slug })
    .from(duetPremises)
    .where(eq(duetPremises.status, 'ready'));
  return [...Object.keys(DUET_PREMISES), ...rows.map((row) => row.slug)];
}

/**
 * The premise behind a slug, seed or written, whatever its status: a retired
 * one is still the premise of the duets that used it. Null if there's none.
 */
export async function loadPremise(tx: Executor, slug: string): Promise<DuetPremise | null> {
  const seed = DUET_PREMISES[slug];
  if (seed) return seed;
  const [row] = await tx
    .select({ content: duetPremises.content })
    .from(duetPremises)
    .where(eq(duetPremises.slug, slug))
    .limit(1);
  return row ? duetPremiseSchema.parse(row.content) : null;
}

/** Side A's title and setting of every premise that can be given, for the writer to vary from. */
export async function premiseSummaries(
  tx: Executor
): Promise<{ title: string; setting: string }[]> {
  const rows = await tx
    .select({ content: duetPremises.content })
    .from(duetPremises)
    .where(eq(duetPremises.status, 'ready'));
  return [...Object.values(DUET_PREMISES), ...rows.map((row) => row.content)].map((premise) => ({
    title: premise.a.title,
    setting: premise.a.setting,
  }));
}
