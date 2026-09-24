import { env } from '@/env';
import { ForbiddenError, NotFoundError } from '@/lib/utils/errors';
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

  const user = await userReader.getUserByClerkId(SEED_CLERK_ID);
  if (!user) {
    throw new NotFoundError('Seed user. Run `pnpm db:seed` to create the account the lab plays as');
  }
  return user;
}
