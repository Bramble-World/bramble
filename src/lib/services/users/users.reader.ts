import { db } from '@/index';
import { and, eq, isNull } from 'drizzle-orm';
import { PublicUser, User } from './users.types';
import { users } from '@/db/schema/tables';

export async function getUserByClerkId(clerkId: string): Promise<PublicUser | null> {
  const [user] = await db
    .select({
      id: users.id,
      clerkId: users.clerkId,
      email: users.email,
      shareUsage: users.shareUsage,
    })
    .from(users)
    .where(and(eq(users.clerkId, clerkId), isNull(users.deletedAt)))
    .limit(1);
  return user ?? null;
}

/**
 * Ignores the soft-delete filter. Used only to tell apart the reasons an insert
 * did nothing: a soft-deleted row still owns the unique clerk_id, so the normal
 * reader misses it and the caller would otherwise loop trying to provision.
 */
export async function getUserByClerkIdIncludingDeleted(
  clerkId: string
): Promise<(PublicUser & Pick<User, 'deletedAt'>) | null> {
  const [user] = await db
    .select({
      id: users.id,
      clerkId: users.clerkId,
      email: users.email,
      shareUsage: users.shareUsage,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  return user ?? null;
}

/**
 * A user by their internal id.
 *
 * Every other reader here takes a `clerkId`, because every other caller arrives
 * from an authenticated request. This one exists for the paths that do not: a
 * background worker holds the `users.id` from the row it is processing and has
 * no identity provider in sight.
 */
export async function getUserById(id: string): Promise<PublicUser | null> {
  const [user] = await db
    .select({
      id: users.id,
      clerkId: users.clerkId,
      email: users.email,
      shareUsage: users.shareUsage,
    })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return user ?? null;
}

/**
 * Whether this reader has opted into usage events.
 *
 * Its own query rather than a field off a fuller read, because it runs before
 * every capture and has no use for the rest of the row.
 *
 * **Absent means no.** A deleted user, or an id that matches nothing, is not
 * someone who agreed to anything — and an analytics path is the last place that
 * should treat "I could not find out" as consent.
 */
export async function sharesUsage(id: string): Promise<boolean> {
  const [row] = await db
    .select({ shareUsage: users.shareUsage })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return row?.shareUsage ?? false;
}
