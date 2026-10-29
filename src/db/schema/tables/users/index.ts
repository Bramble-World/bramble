import { softDelete, timestamps } from '../../../util/timestamps';
import {
  boolean,
  check,
  pgTable,
  timestamp,
  uuid,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * The Clerk user this row belongs to. Null only for a guest, who has played
     * before signing up and has no Clerk account yet — see `isGuest`. The CHECK
     * below is what keeps "null" from meaning anything else.
     */
    clerkId: text('clerk_id').unique(),
    /** Null only for a guest, for the same reason. */
    email: text(),
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

    /**
     * Someone playing on the iPhone before they have signed up.
     *
     * A real row rather than a parallel table, so the whole play loop — every
     * reader, writer and cascade keyed on `users.id` — works for a guest without
     * a single branch. Signing up either attaches a Clerk identity to this row
     * or moves its story into an existing account and deletes it
     * (`src/lib/services/guests/guests.claim.ts`).
     */
    isGuest: boolean('is_guest').notNull().default(false),
    /**
     * When the guest sweep deletes this row, and everything it owns with it.
     * Seven days after creation; also the guest token's `exp`. Null for an
     * account, which never expires.
     */
    guestExpiresAt: timestamp('guest_expires_at', { withTimezone: true }),
    /**
     * The App Attest key the guest was created with, so one attested key holds
     * at most one live guest. An opaque identifier Apple derives from a key on
     * the device — not a device id, and nothing that identifies a person.
     * Cleared when the guest signs up, because nothing needs it after that.
     */
    appAttestKeyId: text('app_attest_key_id'),

    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('idx_users_clerk').on(table.clerkId),
    uniqueIndex('idx_users_active')
      .on(table.email)
      .where(sql`${table.deletedAt} IS NULL`),
    /**
     * An account always has both halves of its identity. Only a guest may lack
     * them, and a guest always has an expiry — otherwise "nullable" would quietly
     * admit an account no sweep will ever clean up and no sign-in can reach.
     */
    check(
      'chk_users_account_identity',
      sql`${table.isGuest} OR (${table.clerkId} IS NOT NULL AND ${table.email} IS NOT NULL)`
    ),
    check(
      'chk_users_guest_expiry',
      sql`NOT ${table.isGuest} OR ${table.guestExpiresAt} IS NOT NULL`
    ),
    // The sweep's scan: expired guests, oldest first. Partial, so the index
    // holds only guests rather than every account.
    index('idx_users_guest_expiry')
      .on(table.guestExpiresAt)
      .where(sql`${table.isGuest}`),
    // One live guest per attested key. Expired guests the sweep has not reached
    // yet are deleted in the same transaction that creates the next one, so an
    // hour's lag in the sweep cannot lock a device out.
    uniqueIndex('idx_users_guest_attest_key')
      .on(table.appAttestKeyId)
      .where(sql`${table.isGuest} AND ${table.deletedAt} IS NULL`),
  ]
);
