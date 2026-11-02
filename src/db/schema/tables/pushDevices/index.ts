import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';

/**
 * One install of the iPhone app that accepts push notifications.
 *
 * `token` is unique across every user, not per user: Apple's token addresses an
 * install, so when someone else signs in on the same phone the row moves to them
 * and the last person stops getting their notifications.
 *
 * `environment` is which of Apple's services issued the token. A TestFlight or
 * App Store build uses production and a Debug build sandbox, and a token only
 * works on the service that issued it.
 *
 * `timeZone` is an IANA name, so a notification can respect the reader's waking
 * hours. Energy never needed one; delivery does.
 */
export const pushDevices = pgTable(
  'push_devices',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    environment: text().notNull(),
    timeZone: text('time_zone').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    index('idx_push_devices_user').on(table.userId),
    check('chk_push_devices_environment', sql`${table.environment} IN ('sandbox', 'production')`),
  ]
);
