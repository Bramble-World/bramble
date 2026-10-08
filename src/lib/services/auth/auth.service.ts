import { UnauthorizedError } from '@/lib/utils/errors';
import { getOrCreateFromClerk } from '@/lib/services/users/users.service';
import { PublicUser } from '@/lib/services/users/users.types';
import { identityFromClerkUser } from '@/lib/services/users/users.identity';
import { clerkBackend } from './auth.client';
import { clerkEnabled } from './auth.config';

/**
 * Resolves the Clerk user id from an `Authorization: Bearer <session jwt>` header.
 *
 * Takes a Request rather than calling `auth()`, deliberately. `auth()` throws
 * unless clerkMiddleware has run, and src/proxy.ts short-circuits to a
 * pass-through whenever Clerk keys are absent — so `auth()` would raise a plain
 * Error (a 500) on a bare checkout. Next's own proxy guidance also asks for
 * verification inside the handler rather than reliance on the proxy.
 *
 * Throws UnauthorizedError, which handleError maps to a 401 in the standard
 * envelope. It never returns a Response, so the envelope stays defined once.
 */
export async function requireClerkUserId(request: Request): Promise<string> {
  // Checked first so the failure is identical with and without Clerk configured.
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError();
  }

  // authenticateRequest asserts a valid secret key and throws a raw Error when
  // one is missing. An unconfigured server still cannot authenticate anyone, so
  // answer 401 rather than letting that become a 500.
  if (!clerkEnabled) {
    throw new UnauthorizedError();
  }

  const state = await clerkBackend.authenticateRequest(request, {
    acceptsToken: 'session_token',
  });

  // Covers signed-out and handshake alike. Handshake only arises on the cookie
  // path, which a bearer request never takes, and its redirect is dropped on
  // purpose: an API client gets a 401, never a 302.
  if (!state.isAuthenticated) {
    throw new UnauthorizedError();
  }

  return state.toAuth().userId;
}

/**
 * The full identity: verifies the bearer token and resolves it to a local users
 * row, provisioning one on first sight.
 *
 * The Clerk lookup is passed into the users layer as a callback so that layer
 * stays free of Clerk — clerk_id is the only thing it knows about the identity
 * provider.
 */
export async function requireCurrentUser(request: Request): Promise<PublicUser> {
  const clerkId = await requireClerkUserId(request);

  return getOrCreateFromClerk(clerkId, async () => {
    const identity = identityFromClerkUser(await clerkBackend.users.getUser(clerkId));
    if (!identity) {
      throw new UnauthorizedError('Clerk account has no email address');
    }
    return identity;
  });
}
