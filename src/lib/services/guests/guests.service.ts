import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/index';
import { persons, users } from '@/db/schema/tables';
import { ConflictError } from '@/lib/utils/errors';
import { assertGuestTokensConfigured, signGuestToken } from '@/lib/services/auth/guest-token';

/**
 * How long a guest's story is kept if they never sign up.
 *
 * Long enough to come back to a cliffhanger over a week — "read it again" works
 * until then — and short enough that a story nobody saved is not ours to keep.
 * Also the guest token's lifetime: there is nothing for a token to unlock once
 * its guest is gone. The privacy policy states this number.
 */
export const GUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a guest's self person is called.
 *
 * A guest never tells us their own name, and the person row needs one. The turn
 * prompt already writes to the reader as "you" and marks the protagonist so, so
 * this is what the model would have called them anyway. Signing into an account
 * that has a self person merges this one into it, name and all.
 */
export const GUEST_SELF_NAME = 'You';

export type CreatedGuest = {
  token: string;
  expiresAt: Date;
  user: { id: string };
};

/**
 * Creates a guest: a `users` row with no Clerk identity, its self person, and a
 * token to play with.
 *
 * The self person is created here, with the row, because every user needs
 * exactly one and nothing else would create it for a guest (invariants.md §5).
 *
 * `appAttestKeyId` is null when attestation is off. When it is set, at most one
 * live guest may hold it — the partial unique index enforces that — so a guest
 * the sweep has not reached yet is deleted first, in the same transaction, and
 * an hour's lag in the sweep cannot lock a device out of a fresh start.
 */
export async function createGuest(appAttestKeyId: string | null): Promise<CreatedGuest> {
  // Before any write: without a secret there is no token to hand back, and a
  // guest row nobody can reach is litter the sweep would have to collect.
  assertGuestTokensConfigured();

  const expiresAt = new Date(Date.now() + GUEST_LIFETIME_MS);

  const user = await db.transaction(async (tx) => {
    if (appAttestKeyId) {
      await tx
        .delete(users)
        .where(
          and(
            eq(users.appAttestKeyId, appAttestKeyId),
            eq(users.isGuest, true),
            lte(users.guestExpiresAt, sql`now()`)
          )
        );
    }

    // Untargeted, like `insertUserIfAbsent`: the only constraint a guest insert
    // can hit is the one-live-guest-per-key index, and a null return says so.
    const [row] = await tx
      .insert(users)
      .values({ isGuest: true, guestExpiresAt: expiresAt, appAttestKeyId })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!row) {
      throw new ConflictError(
        'This device already has a guest. Generate a new App Attest key to start another.'
      );
    }

    await tx.insert(persons).values({ userId: row.id, name: GUEST_SELF_NAME, isSelf: true });
    return row;
  });

  return { token: await signGuestToken(user.id, expiresAt), expiresAt, user };
}

/** How many expired guests one statement deletes, so a backlog cannot become one huge cascade. */
const SWEEP_BATCH = 200;

/**
 * Deletes every guest past its expiry, and with it everything they played.
 *
 * Every table cascades from `users`, so deleting the row is the whole job —
 * `purge.integration.test.ts` is what proves that stays true. Batched, because
 * each guest takes a storyline, its people, events and turns with it, and one
 * statement over a week's backlog would hold its locks for as long as all of
 * that takes. A claimed guest is no longer `isGuest` and is never touched.
 */
export async function sweepExpiredGuests(): Promise<{ deleted: number }> {
  let deleted = 0;

  for (;;) {
    const expired = db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isGuest, true), lte(users.guestExpiresAt, sql`now()`)))
      .limit(SWEEP_BATCH);

    const rows = await db
      .delete(users)
      // Re-checked on the delete itself, so a guest claimed between the two
      // halves of this statement is not swept out from under its new account.
      .where(and(inArray(users.id, expired), eq(users.isGuest, true)))
      .returning({ id: users.id });

    deleted += rows.length;
    if (rows.length < SWEEP_BATCH) return { deleted };
  }
}
