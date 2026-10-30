import { SignJWT, decodeJwt, importPKCS8 } from 'jose';
import { env } from '@/env';
import { AppError } from '@/lib/utils/errors';

/**
 * Revoking a player's Sign in with Apple, for account deletion.
 *
 * Apple requires an app that offers Sign in with Apple to revoke the player's
 * tokens when they delete their account (guideline 5.1.1(v)), so the app stops
 * appearing under their Apple ID's "Sign in with Apple".
 *
 * Revoking needs a token, and nothing here holds one: the iPhone signs in
 * natively, which hands Clerk only Apple's identity token. So the app signs in
 * with Apple once more to confirm the deletion and sends the authorization code
 * from that sign-in. Trading it at `/auth/token` gives a refresh token, which
 * is revoked straight away and never stored. The trade is also the proof of a
 * fresh sign-in: a code is single-use and lives five minutes.
 *
 * Apple's endpoints are plain HTTPS form posts; `fetch` is the whole client.
 */

const APPLE = 'https://appleid.apple.com';

/** Apple refused the code, or the key is wrong. Nothing has been deleted yet. */
export class AppleRevocationError extends AppError {
  constructor(message: string) {
    super(message, 'APPLE_REVOCATION_FAILED', 502);
  }
}

/** Whether this server can trade and revoke Apple tokens at all. */
export function appleRevocationConfigured(): boolean {
  return Boolean(env.APPLE_TEAM_ID && env.APPLE_SIGN_IN_KEY_ID && env.APPLE_SIGN_IN_PRIVATE_KEY);
}

/**
 * The client secret Apple's token endpoints take: an ES256 JWT signed with the
 * Sign in with Apple key, at most six months long. Made per call — it costs a
 * signature, and a cached one is one more thing to expire at the wrong moment.
 */
async function clientSecret(): Promise<string> {
  if (!appleRevocationConfigured()) {
    throw new AppleRevocationError('Sign in with Apple revocation is not configured.');
  }
  // Doppler keeps multi-line values, but a key pasted as one line with literal
  // \n is common enough to accept.
  const pem = env.APPLE_SIGN_IN_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_SIGN_IN_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .setAudience(APPLE)
    .setSubject(env.APPLE_SIGN_IN_CLIENT_ID)
    .sign(key);
}

async function post(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${APPLE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
}

/**
 * Trades an authorization code for the Apple user it belongs to and a refresh
 * token. Throws when Apple refuses it: expired, used already, or from another
 * app.
 *
 * The identity token in the answer is read without verifying its signature on
 * purpose. It came straight from Apple over TLS in reply to our own signed
 * request, which is the strongest provenance a token can have; verifying it
 * against Apple's keys would only re-check that.
 */
export async function exchangeAppleCode(
  code: string
): Promise<{ appleUserId: string; refreshToken: string }> {
  const res = await post('/auth/token', {
    client_id: env.APPLE_SIGN_IN_CLIENT_ID,
    client_secret: await clientSecret(),
    code,
    grant_type: 'authorization_code',
  });
  if (!res.ok) {
    // Apple's error body is a code like `invalid_grant` — structural, safe to log.
    const reason = await res
      .json()
      .then((b: { error?: string }) => b.error ?? 'unknown')
      .catch(() => 'unreadable');
    throw new AppleRevocationError(
      `Apple refused the authorization code (${res.status} ${reason}).`
    );
  }
  const body = (await res.json()) as { id_token?: string; refresh_token?: string };
  const sub = body.id_token ? decodeJwt(body.id_token).sub : undefined;
  if (!sub || !body.refresh_token) {
    throw new AppleRevocationError('Apple answered without an identity or a refresh token.');
  }
  return { appleUserId: sub, refreshToken: body.refresh_token };
}

/** Revokes a refresh token, which ends the app's Sign in with Apple for that player. */
export async function revokeAppleToken(refreshToken: string): Promise<void> {
  const res = await post('/auth/revoke', {
    client_id: env.APPLE_SIGN_IN_CLIENT_ID,
    client_secret: await clientSecret(),
    token: refreshToken,
    token_type_hint: 'refresh_token',
  });
  if (!res.ok) {
    throw new AppleRevocationError(`Apple refused the revocation (${res.status}).`);
  }
}
