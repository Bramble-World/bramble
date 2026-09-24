import { env } from '@/env';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as userReader from '@/lib/services/users/users.reader';
import { PublicUser } from '@/lib/services/users/users.types';

/** The account the seed builds. Owns every seeded storyline. */
export const SEED_CLERK_ID = 'user_seed_demo';

/**
 * The user the harness acts as.
 *
 * The seeded storylines belong to an account with no Clerk session behind it, so
 * without this the harness would have nothing to play and the first thing anyone
 * did would be sign up and stare at an empty list.
 *
 * It **hard-fails anywhere but development**, and that is the whole design. The
 * Next.js docs are explicit that a Server Action is a POST endpoint reachable by
 * anyone who can send the request, and that rendering a page behind a check is
 * not a security boundary. A resolver that silently fell back to a fixed user
 * would therefore be an unauthenticated write surface in production — so it
 * throws rather than falling back, and the throw is the point rather than a
 * safety net.
 *
 * The real path in auth.service.ts is untouched and is what the API routes will
 * use. This exists only so the pipeline can be played before those exist.
 */
export async function requireLabUser(): Promise<PublicUser> {
  if (env.NODE_ENV !== 'development') {
    throw new ForbiddenError('The lab is available in development only');
  }

  // Checked before querying, because the failure otherwise is unreadable. With
  // no DATABASE_URL the db falls back to a placeholder host so that importing it
  // cannot crash a route, and the first query then fails with drizzle's generic
  // "Failed query" wrapper — which reports the SQL and hides the cause. The
  // actual mistake is almost always starting the server without Doppler, so say
  // that instead.
  if (!env.DATABASE_URL) {
    throw new ValidationError(
      'DATABASE_URL is not set. Start the server with `pnpm dev:doppler` rather than `pnpm dev`.'
    );
  }

  const user = await userReader.getUserByClerkId(SEED_CLERK_ID);
  if (!user) {
    throw new NotFoundError('Seed user. Run `pnpm db:seed` to create the account the lab plays as');
  }
  return user;
}
