import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { env } from '@/env';
import { InternalServerError, UnauthorizedError } from '@/lib/utils/errors';

/**
 * The token a guest plays with, before they have a Clerk account.
 *
 * One HS256 JWT, signed here and verified here — nobody else ever needs to read
 * it, so a shared secret is the whole of the key management. It lives as long as
 * the guest does (`exp` is `guestExpiresAt`) rather than being short and
 * refreshed, because what makes a guest token stop working is not its `exp` but
 * the row behind it: every request re-reads the `users` row (`getLiveGuest`), so
 * deleting a guest, claiming it into an account or letting it expire ends the
 * token at once. A refresh dance would add a second credential to steal and
 * revoke nothing the row does not already revoke.
 *
 * **The issuer is the dispatch key.** `requireCurrentUser` sends a bearer token
 * down this path only when its unverified `iss` is this value, and down the
 * Clerk path otherwise — so a Clerk token is never tried against this secret,
 * and a malformed or forged token still gets Clerk's identical 401. Reading an
 * unverified claim to *choose* a verifier is safe precisely because the chosen
 * verifier then checks everything, including that same claim.
 */
export const GUEST_TOKEN_ISSUER = 'https://api.brambleworld.com/guest';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HS256 only. Anything else, `none` above all, is rejected before the signature. */
const ALGORITHM = 'HS256';

function secretKey(): Uint8Array | null {
  const secret = env.GUEST_TOKEN_SECRET;
  return secret ? new TextEncoder().encode(secret) : null;
}

/**
 * Whether guest tokens can be issued at all. Asked before a guest is created,
 * so a missing secret refuses the request rather than leaving behind a guest
 * row nobody holds a token for.
 */
export function assertGuestTokensConfigured(): void {
  if (!secretKey()) {
    throw new InternalServerError('GUEST_TOKEN_SECRET is not set, so guests cannot be created.');
  }
}

/**
 * Signs a token for a guest. Throws when no secret is configured, rather than
 * signing with something weaker: guest creation fails closed, loudly.
 */
export async function signGuestToken(userId: string, expiresAt: Date): Promise<string> {
  assertGuestTokensConfigured();
  const key = secretKey()!;

  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(GUEST_TOKEN_ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);
}

/**
 * Whether a bearer token claims to be one of ours.
 *
 * Unverified on purpose — see the module comment. Anything that does not even
 * decode is not a guest token, and goes to the Clerk path to be refused there
 * exactly as it always was.
 */
export function isGuestToken(token: string): boolean {
  try {
    return decodeJwt(token).iss === GUEST_TOKEN_ISSUER;
  } catch {
    return false;
  }
}

/**
 * Verifies a guest token and returns the user id it names.
 *
 * Every failure is the same bare 401, whatever the reason — expired, tampered,
 * wrong issuer, wrong algorithm, no secret configured. Differentiating them
 * would hand a caller an oracle and buys a client nothing: its only remedy for
 * any of them is a new guest.
 *
 * This proves only that we issued the token. Whether the guest can still play
 * is the row's question, and the caller must ask it.
 */
export async function verifyGuestToken(token: string): Promise<string> {
  const key = secretKey();
  if (!key) throw new UnauthorizedError();

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: GUEST_TOKEN_ISSUER,
      algorithms: [ALGORITHM],
      requiredClaims: ['sub', 'exp'],
    });
    // A uuid or nothing: the caller queries `users.id` with it, and a value
    // Postgres cannot cast would be a 500 rather than the 401 it deserves.
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
      throw new UnauthorizedError();
    }
    return payload.sub;
  } catch {
    throw new UnauthorizedError();
  }
}
