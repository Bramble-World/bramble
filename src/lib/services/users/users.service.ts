import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '@/lib/utils/errors';
import * as reader from './users.reader';
import * as writer from './users.writer';
import { PublicUser } from './users.types';
import { ClerkIdentity } from './users.identity';

export async function getUserByClerkId(clerkId: string): Promise<PublicUser> {
  const user = await reader.getUserByClerkId(clerkId);
  if (!user) {
    // NotFoundError composes its own message from (resource, id).
    throw new NotFoundError('User', clerkId);
  }
  return user;
}

/**
 * The guest a verified guest token names, if they can still play.
 *
 * A token that verifies but names nobody live — deleted, claimed into an
 * account, or past its expiry — is the same 401 as a token that does not
 * verify, so nothing here distinguishes them for a caller.
 */
export async function requireLiveGuest(id: string): Promise<PublicUser> {
  const guest = await reader.getLiveGuest(id);
  if (!guest) throw new UnauthorizedError();
  return guest;
}

/**
 * Maps a Clerk user id onto a local users row, creating it on first sight.
 *
 * Read, insert-if-absent, read again. The database arbitrates the race rather
 * than the application: two concurrent first requests both reach the insert,
 * one gets a row back and the other gets nothing, then re-reads the winner's
 * row. No advisory lock, no retry loop.
 */
export async function getOrCreateFromClerk(
  clerkId: string,
  fetchIdentity: () => Promise<ClerkIdentity>
): Promise<PublicUser> {
  const existing = await reader.getUserByClerkId(clerkId);
  if (existing) return existing;

  // Only on first sight — the default Clerk session token carries no email
  // claim, and an account row must have one (chk_users_account_identity).
  const identity = await fetchIdentity();

  const inserted = await writer.insertUserIfAbsent({
    clerkId,
    email: identity.email,
    verified: identity.verified,
  });
  if (inserted) return inserted;

  // The insert was a no-op. Exactly three things cause that.
  const raced = await reader.getUserByClerkId(clerkId);
  if (raced) return raced; // 1. a concurrent first request won

  const anyRow = await reader.getUserByClerkIdIncludingDeleted(clerkId);
  if (anyRow?.deletedAt) {
    // 2. soft-deleted: the row still owns the unique clerk_id
    throw new ForbiddenError('This account has been deleted');
  }
  // 3. the email belongs to a different clerk_id
  throw new ConflictError(`${identity.email} is already registered`);
}
