import { json } from '@/lib/api/respond';
import { assertClientSupported } from '@/lib/api/client-version';
import { handleError } from '@/lib/utils/api.handler-errors';
import { issueChallenge } from '@/lib/services/guests/attestation';
import {
  assertUnderIpLimit,
  CHALLENGES_PER_IP_PER_HOUR,
  clientIp,
} from '@/lib/services/guests/ip-limit';

/**
 * A single-use challenge to attest a new App Attest key against.
 *
 * The app hashes this string (its UTF-8 bytes, SHA-256) into `clientDataHash`
 * for `attestKey`, then sends the attestation and the challenge to
 * `POST /api/v1/guests`. A challenge is good for five minutes and one attempt —
 * used, failed or expired, the next attempt needs a new one.
 *
 * Served whether or not attestation is currently required, so the app has one
 * flow everywhere; where it is off, `POST /api/v1/guests` ignores the result.
 *
 * POST rather than GET because each call creates server state, and a GET that
 * an intermediary repeated or prefetched would mint challenges nobody asked for.
 */
export async function POST(request: Request) {
  try {
    assertClientSupported(request);
    await assertUnderIpLimit('guest-challenges', clientIp(request), CHALLENGES_PER_IP_PER_HOUR);

    const { challenge, expiresAt } = await issueChallenge();
    return json({ challenge, expiresAt: expiresAt.toISOString() }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
