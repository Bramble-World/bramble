import { softDelete, timestamps } from '../../../util/timestamps';
import { boolean, pgTable, timestamp, uuid, text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    clerkId: text('clerk_id').notNull().unique(),
    email: text().notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /**
     * Whether this reader lets us see how they use the app.
     *
     * Defaults to true, which is a product decision rather than a technical one:
     * the events are counts and durations about the app's own behaviour, never
     * anything they wrote. The toggle is in the Mac app, and it is honoured
     * server-side as well as client-side — an opt-out that only silenced the
     * client would be a promise the server quietly broke.
     */
    shareUsage: boolean('share_usage').notNull().default(true),

    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('idx_users_clerk').on(table.clerkId),
    uniqueIndex('idx_users_active')
      .on(table.email)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);
