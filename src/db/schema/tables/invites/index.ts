import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { duets } from '../duets';

/**
 * An invitation to a story for two (`duets`), opened by a 6-letter code.
 *
 * Holds only what's needed to make the story: who invited, the first name they
 * gave (shown to whoever opens the code), when it expires, and once accepted,
 * who accepted and the duet it made. Deleting the inviter deletes their
 * invites; deleting whoever accepted leaves the invite, without them.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text().notNull(),
    inviterUserId: uuid('inviter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** How the inviter wants to be known in the story: a first name, as they typed it. */
    inviterName: text('inviter_name').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    duetId: uuid('duet_id').references((): AnyPgColumn => duets.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('idx_invites_code').on(table.code),
    index('idx_invites_inviter').on(table.inviterUserId, table.createdAt),
  ]
);
