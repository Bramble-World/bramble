import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { storylines } from '../storylines';
import { storyTurns } from '../storylineSessions/storyTurns';
import { duets } from '../duets';

/**
 * Something one player did in a story for two that the other player's
 * character would know about (invariants.md §3, "crossings"), on its way into
 * the other side.
 *
 * It belongs to the player it's going to (`toUserId`, cascading with them):
 * it is their story's material, written from what the other side recorded,
 * and it reaches them only as their next beat, written by the model from it.
 * Nothing here says who it came from beyond the side, so when that player
 * leaves, their rows are deleted and what already reached the other side
 * stays only as story text (`forgetDuetPartner`).
 *
 * `toStorylineId` is null while the receiving side hasn't started; its first
 * beat then opens with the newest one.
 */
export const duetCrossings = pgTable(
  'duet_crossings',
  {
    id: uuid().primaryKey().defaultRandom(),
    duetId: uuid('duet_id')
      .notNull()
      .references(() => duets.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The side it came from, `a` or `b`. */
    fromSide: text('from_side').notNull(),
    toStorylineId: uuid('to_storyline_id').references(() => storylines.id, { onDelete: 'cascade' }),
    /** What happened, as the side it came from recorded it. */
    title: text().notNull(),
    description: text().notNull(),
    /** `queued`, `delivered` (in `deliveredTurnId`), or `dropped` (past the cap, or the side ended). */
    status: text().notNull().default('queued'),
    deliveredTurnId: uuid('delivered_turn_id').references(() => storyTurns.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    index('idx_duet_crossings_to').on(table.toUserId, table.status),
    index('idx_duet_crossings_storyline').on(table.toStorylineId, table.status),
    check('chk_duet_crossings_side', sql`${table.fromSide} IN ('a', 'b')`),
    check('chk_duet_crossings_status', sql`${table.status} IN ('queued', 'delivered', 'dropped')`),
  ]
);
