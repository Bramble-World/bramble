import { db } from '@/index';
import { and, eq, isNull } from 'drizzle-orm';
import { User } from './users.types';
import { users } from '@/db/schema/tables';
export async function getUserByClerkId(
  clerkId: string
): Promise<Pick<User, 'id' | 'clerkId' | 'email'> | null> {
  const [user] = await db
    .select({ id: users.id, clerkId: users.clerkId, email: users.email })
    .from(users)
    .where(and(eq(users.clerkId, clerkId), isNull(users.deletedAt)));
  return user ?? null;
}
