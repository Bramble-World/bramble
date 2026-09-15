import { db } from '@/index';
import { and, eq, isNull } from 'drizzle-orm';
import { PublicUser, User } from './users.types';
import { users } from '@/db/schema/tables';

export async function getUserByClerkId(clerkId: string): Promise<PublicUser | null> {
  const [user] = await db
    .select({ id: users.id, clerkId: users.clerkId, email: users.email })
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
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  return user ?? null;
}
