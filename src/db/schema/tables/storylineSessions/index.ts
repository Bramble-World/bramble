import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
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

    ...timestamps,
  },
  (table) => [
    index('idx_storyline_sessions_storyline').on(table.storylineId),
    index('idx_storyline_sessions_user').on(table.userId),
    // Supports the idle sweep: WHERE last_active_at < now() - <threshold>.
    index('idx_storyline_sessions_last_active').on(table.lastActiveAt),
  ]
);
