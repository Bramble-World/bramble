import { softDelete, timestamps } from '../../../util/timestamps';
import { pgTable, timestamp, uuid, text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    clerkId: text('clerk_id').notNull().unique(),
    email: text().notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
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
