import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { storyTemplates } from '@/db/schema/tables/storyTemplates';
import { SEED_STORIES } from './seeds';

/**
 * Writes the team's seed stories into the pool, by slug. Runs after the
 * migrations on every deploy (`src/db/migrate.ts`), so the pool is never empty.
 *
 * An existing seed's story is replaced, so an edit to its file reaches players
 * who have not started it; copies already started are their own rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedPool(db: NodePgDatabase<any>): Promise<number> {
  for (const [slug, content] of Object.entries(SEED_STORIES)) {
    await db
      .insert(storyTemplates)
      .values({ origin: 'seed', slug, status: 'ready', content })
      .onConflictDoUpdate({
        target: storyTemplates.slug,
        set: { content, status: 'ready', updatedAt: new Date() },
      });
  }
  return Object.keys(SEED_STORIES).length;
}
