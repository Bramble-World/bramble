import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { PublicUser, NewUser } from './users.types';

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
      email: input.email,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: users.id, clerkId: users.clerkId, email: users.email });

  return user ?? null;
}
