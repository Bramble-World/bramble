import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import type { DuetPremise } from '@/lib/duets/premise';

/**
 * Duet premises written by the model (`duet.write`, checked by `duet.check`),
 * beside the hand-written seeds in `src/lib/duets/seeds`. A premise is about
 * nobody: every person in it is invented and the two players are placeholders
 * (`PARTNER`), so it belongs to no player and has no user column.
 *
 * Only premises that passed are written; a rejected one never reaches here.
 * `status` can retire one later without deleting the duets that used it.
 */
export const duetPremises = pgTable(
  'duet_premises',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** What `duets.premise` holds: `gen-` and 8 hex digits. Seeds use their file name. */
    slug: text().notNull(),
    status: text({ enum: ['ready', 'retired'] })
      .notNull()
      .default('ready'),
    content: jsonb().$type<DuetPremise>().notNull(),
    /** The check's 1-5 score, for picking and for review. */
    qualityScore: integer('quality_score').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('idx_duet_premises_slug').on(table.slug)]
);
