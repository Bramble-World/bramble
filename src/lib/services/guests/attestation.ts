import { randomBytes } from 'node:crypto';
import { env } from '@/env';
import { redis } from '@/lib/redis/client';
import { ForbiddenError, ValidationError } from '@/lib/utils/errors';
import { AttestationError, verifyAttestation } from './app-attest';

/**
 * Whether creating a guest needs an App Attest attestation, and the challenges
 * that make one usable exactly once.
 *
 * App Attest is how a guest is limited per device without a device identifier:
 * the iPhone generates a key in its Secure Enclave, Apple certifies that the key
 * belongs to a genuine install of our app, and the server keeps the key's id
 * (`users.appAttestKeyId`) so one key holds at most one live guest. No
 * advertising identifier, no device id — the key id identifies a key, which
 * the app can throw away.
 */

/** The App ID attestations must be issued for: `<team id>.<bundle id>`. */
export const APP_ID = 'K555FJZF47.com.brambleworld.BrambleMobile';

/**
 * How long a challenge waits to be used.
 *
 * Long enough for a slow first launch to generate a key and talk to Apple,
 * short enough that a challenge left lying around is not worth collecting.
 */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

const CHALLENGE_PREFIX = 'guest:attest:challenge:';

export type AttestationMode = 'required' | 'off';

/**
 * 'required' wherever the production build runs — staging and production both
 * set NODE_ENV=production — unless explicitly turned off, and 'off' for local
 * development and CI, which have no iPhone to attest with.
 */
export function attestationMode(): AttestationMode {
  return env.GUEST_ATTESTATION ?? (env.NODE_ENV === 'production' ? 'required' : 'off');
}

/**
 * Issues a single-use challenge.
 *
 * Random, opaque, and remembered only in Redis with a short expiry: the server
 * keeps nothing else about it, and nothing about who asked. The app hashes the
 * UTF-8 bytes of exactly this string into `clientDataHash`.
 */
export async function issueChallenge(): Promise<{ challenge: string; expiresAt: Date }> {
  const challenge = randomBytes(32).toString('base64url');
  await redis('guest attestation challenges cannot be issued').set(
    CHALLENGE_PREFIX + challenge,
    '1',
    'EX',
    CHALLENGE_TTL_SECONDS
  );
  return { challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000) };
}

export type AttestationClaim = {
  keyId: string;
  /** The attestation object, base64. */
  attestationObject: string;
  /** The challenge from `POST /api/v1/guests/challenge`, exactly as issued. */
  challenge: string;
};

/**
 * Checks a guest-creation request's attestation, under the configured mode.
 *
 * Returns the attested key id, or null when attestation is off — in which case
 * anything the client sent is ignored rather than half-checked, because a check
 * that runs only sometimes is a check nobody can reason about.
 *
 * The challenge is consumed **before** the attestation is verified, so a failed
 * attempt still spends it: a challenge that survived a failure could be replayed
 * against the verifier as often as someone liked.
 *
 * Every refusal after the shape check is the same 403 with the same message. Which
 * step failed is logged by name for us and told to nobody else.
 */
export async function attestedKeyId(claim: AttestationClaim | undefined): Promise<string | null> {
  if (attestationMode() === 'off') return null;

  if (!claim) {
    throw new ValidationError('This device has to be verified to play as a guest.', {
      attestation: 'Required',
    });
  }

  const consumed = await redis('guest attestation challenges cannot be checked').del(
    CHALLENGE_PREFIX + claim.challenge
  );
  if (consumed !== 1) throw unverified('challenge unknown, expired or used');

  try {
    const verified = verifyAttestation({
      attestation: Buffer.from(claim.attestationObject, 'base64'),
      challenge: Buffer.from(claim.challenge, 'utf8'),
      keyId: claim.keyId,
      appId: APP_ID,
      // Unvalidated in CI (SKIP_ENV_VALIDATION), where the schema default never
      // applies — so the safe default is restated here.
      environment: env.APP_ATTEST_ENVIRONMENT ?? 'production',
    });
    return verified.keyId;
  } catch (error) {
    if (error instanceof AttestationError) throw unverified(error.message);
    throw error;
  }
}

function unverified(reason: string): ForbiddenError {
  // The reason is a fixed string from this module or app-attest.ts — never
  // anything the client sent.
  console.warn('guest attestation refused', { reason });
  return new ForbiddenError('This device could not be verified.');
}
