import { index, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { storylines } from '../storylines';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';

export const storylineSessions = pgTable(
  'storyline_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * How far this playthrough has advanced through the storyline's timeline.
     *
     * Holds a `events.narrativeOrder`, and the turn prompt is shown only beats at
     * or below it — without this the model receives the whole source
     * conversation, including events the reader has not reached, and narrates
     * those instead of inventing what happens next.
     *
     * `0` means "before everything", matching the convention `gapOrderAfter`
     * already uses for an empty timeline. It only ever rises; see invariants.md §6.
     */
    playheadOrder: integer('playhead_order').notNull().default(0),

    ...timestamps,
  },
  (table) => [
    index('idx_storyline_sessions_storyline').on(table.storylineId),
    index('idx_storyline_sessions_user').on(table.userId),
    // Supports the idle sweep: WHERE last_active_at < now() - <threshold>.
    index('idx_storyline_sessions_last_active').on(table.lastActiveAt),
  ]
);
