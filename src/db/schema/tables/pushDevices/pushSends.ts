import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';
import { storyTurns } from '../storylineSessions/storyTurns';
import { users } from '../users';

/**
 * One notification the push sweep sent, or is about to.
 *
 * It holds the limits (one a day, and none after the player has ignored enough)
 * and it is what makes a sweep safe to run twice: the row is written before the
 * send, and the unique index means a second writer loses.
 *
 * `anchorTurnId` is the player's latest turn when it was sent, so a new turn
 * starts the count again. `ordinal` tells a second "story waiting" from the first.
 *
 * No text: what a notification says is decided by `kind`.
 */
export const pushSends = pgTable(
  'push_sends',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    anchorTurnId: uuid('anchor_turn_id')
      .notNull()
      .references(() => storyTurns.id, { onDelete: 'cascade' }),
    ordinal: integer().notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_push_sends_once').on(table.anchorTurnId, table.kind, table.ordinal),
    index('idx_push_sends_user').on(table.userId, table.sentAt),
    check('chk_push_sends_kind', sql`${table.kind} IN ('battery_back', 'story_waiting')`),
  ]
);
