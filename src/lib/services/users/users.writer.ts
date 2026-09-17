import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { PublicUser, NewUser, UserPatch } from './users.types';

/**
 * Inserts a user, or does nothing if one already exists.
 *
 * `onConflictDoNothing()` is untargeted on purpose. Targeting clerk_id would
 * absorb the provisioning race but let a duplicate email surface as a raw 23505
 * — a 500 for what is really a 409. Untargeted, every conflict returns zero rows
 * and the caller reads back to discover which constraint it hit.
 */
export async function insertUserIfAbsent(input: NewUser): Promise<PublicUser | null> {
  const [user] = await db
    .insert(users)
    .values({
      clerkId: input.clerkId,
      // Normalised here rather than at each call site: the partial unique index
      // on email is case-sensitive, so 'A@b.com' and 'a@b.com' would otherwise
      // become two rows. Every writer path must agree, so it lives in one place.
      email: input.email.toLowerCase(),
      emailVerifiedAt: input.emailVerifiedAt ?? null,
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
  if (patch.email !== undefined) set.email = patch.email.toLowerCase();
  if (patch.emailVerifiedAt !== undefined) set.emailVerifiedAt = patch.emailVerifiedAt;
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
