import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { NewUser, PublicUser, UserPatch } from './users.types';

/**
 * Derives `email_verified_at` from the incoming address and its verified flag.
 *
 * The column sits beside `email` and therefore describes *that* address, which
 * gives three cases:
 *   - not verified               -> NULL
 *   - verified, same address     -> keep the existing timestamp (first observation)
 *   - verified, new address      -> now()
 *
 * Expressed as one SQL expression so it needs no prior read and cannot race with
 * a concurrent write.
 */
function verifiedAt(email: string, verified: boolean) {
  if (!verified) return null;
  return sql`CASE WHEN ${users.email} = ${email} THEN COALESCE(${users.emailVerifiedAt}, now()) ELSE now() END`;
}

/**
 * Inserts a user, or does nothing if one already exists.
 *
 * `onConflictDoNothing()` is untargeted on purpose. Targeting clerk_id would
 * absorb the provisioning race but let a duplicate email surface as a raw 23505
 * — a 500 for what is really a 409. Untargeted, every conflict returns zero rows
 * and the caller reads back to discover which constraint it hit.
 */
export async function insertUserIfAbsent(input: NewUser): Promise<PublicUser | null> {
  // Normalised here rather than at each call site: the partial unique index on
  // email is case-sensitive, so 'A@b.com' and 'a@b.com' would otherwise become
  // two rows. Every writer path must agree, so it lives in one place.
  const email = input.email.toLowerCase();

  const [user] = await db
    .insert(users)
    .values({
      clerkId: input.clerkId,
      email,
      // No row exists yet, so there is no prior timestamp to preserve.
      emailVerifiedAt: input.verified ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning({ id: users.id, clerkId: users.clerkId, email: users.email });

  return user ?? null;
}

/**
 * Applies a patch to a live user row, returning null if there was nothing to
 * update or no live row to update.
 *
 * Only fields present on the patch are written, so a webhook carrying one
 * changed field can't blank out the others.
 */
export async function updateUserByClerkId(
  clerkId: string,
  patch: UserPatch
): Promise<PublicUser | null> {
  const set: Record<string, unknown> = {};

  if (patch.email !== undefined) {
    const email = patch.email.toLowerCase();
    set.email = email;
    // Only derivable alongside the address, since the answer depends on whether
    // the address changed.
    if (patch.verified !== undefined) set.emailVerifiedAt = verifiedAt(email, patch.verified);
  }

  if (Object.keys(set).length === 0) return null;

  const [user] = await db
    .update(users)
    .set(set)
    .where(and(eq(users.clerkId, clerkId), isNull(users.deletedAt)))
    .returning({ id: users.id, clerkId: users.clerkId, email: users.email });

  return user ?? null;
}

/**
 * Soft-deletes a user. Idempotent: the `deletedAt IS NULL` guard means a
 * redelivered webhook is a no-op rather than moving the deletion timestamp,
 * and an unknown clerkId simply returns null.
 */
export async function softDeleteUserByClerkId(clerkId: string): Promise<PublicUser | null> {
  const [user] = await db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.clerkId, clerkId), isNull(users.deletedAt)))
    .returning({ id: users.id, clerkId: users.clerkId, email: users.email });

  return user ?? null;
}
