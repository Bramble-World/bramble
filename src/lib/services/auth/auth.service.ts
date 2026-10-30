import { UnauthorizedError } from '@/lib/utils/errors';
import { getOrCreateFromClerk, requireLiveGuest } from '@/lib/services/users/users.service';
import { PublicUser } from '@/lib/services/users/users.types';
import { ClerkIdentity, identityFromClerkUser } from '@/lib/services/users/users.identity';
import { clerkBackend } from './auth.client';
import { clerkEnabled } from './auth.config';
import { isGuestToken, verifyGuestToken } from './guest-token';

/**
 * The header a guest token rides in when the bearer slot is already taken.
 *
 * Only `POST /api/v1/guests/claim` needs it: claiming is the one request that
 * carries both identities at once — the Clerk session being signed into, and the
 * guest whose story is moving into it.
 */
export const GUEST_TOKEN_HEADER = 'x-bramble-guest';

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
 * How many minutes ago this session's player last proved who they are with a
 * first factor (a passkey, an email code, a sign-in), or null when Clerk
 * doesn't say.
 *
 * Read from the session token's `fva` claim, which Clerk resets when the app
 * re-verifies the session (`Session.verifyWithPasskey` and friends on iOS) and
 * the app then fetches a fresh token. Verified the same way
 * `requireClerkUserId` verifies, so a forged claim fails the signature first.
 */
export async function clerkFirstFactorAgeMinutes(request: Request): Promise<number | null> {
  if (!clerkEnabled) throw new UnauthorizedError();
  const state = await clerkBackend.authenticateRequest(request, {
    acceptsToken: 'session_token',
  });
  if (!state.isAuthenticated) throw new UnauthorizedError();
  return state.toAuth().factorVerificationAge?.[0] ?? null;
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
  // Dispatched on the token's own issuer, before Clerk sees it. Only a token
  // that claims to be a guest token takes the guest path, and it is verified
  // there in full; everything else — including garbage, alg:none and an
  // expired Clerk session — takes the Clerk path exactly as it did before
  // guests existed, so its 401 is unchanged byte for byte.
  const token = bearerToken(request);
  if (token && isGuestToken(token)) {
    return requireGuest(token);
  }

  const clerkId = await requireClerkUserId(request);
  return getOrCreateFromClerk(clerkId, () => clerkIdentity(clerkId));
}

/**
 * The guest a token names, if they can still play.
 *
 * Two checks, both required: the signature proves we issued the token, and the
 * row read proves the guest still exists, is still a guest and has not expired.
 */
export async function requireGuest(token: string): Promise<PublicUser> {
  return requireLiveGuest(await verifyGuestToken(token));
}

/**
 * The guest named by the `X-Bramble-Guest` header. Same checks, same 401.
 */
export async function requireGuestFromHeader(request: Request): Promise<PublicUser> {
  const token = request.headers.get(GUEST_TOKEN_HEADER)?.trim();
  if (!token) throw new UnauthorizedError();
  return requireGuest(token);
}

/**
 * The email Clerk holds for an account, for provisioning a row.
 *
 * Only on first sight — the default session token carries no email claim. A
 * Clerk account with none cannot become a Bramble account, so it is a 401
 * rather than a row that breaks chk_users_account_identity.
 */
export async function clerkIdentity(clerkId: string): Promise<ClerkIdentity> {
  const identity = identityFromClerkUser(await clerkBackend.users.getUser(clerkId));
  if (!identity) {
    throw new UnauthorizedError('Clerk account has no email address');
  }
  return identity;
}

/** The token from `Authorization: Bearer <token>`, or null. Case-sensitive, like Clerk's. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
