import { z } from 'zod';
import { json } from '@/lib/api/respond';
import { parseOptionalBody } from '@/lib/api/params';
import { assertClientSupported } from '@/lib/api/client-version';
import { handleError } from '@/lib/utils/api.handler-errors';
import { attestedKeyId } from '@/lib/services/guests/attestation';
import { createGuest } from '@/lib/services/guests/guests.service';
import {
  assertUnderIpLimit,
  clientIp,
  GUESTS_PER_IP_PER_HOUR,
} from '@/lib/services/guests/ip-limit';

const bodySchema = z.object({
  /**
   * Required when the server requires attestation (staging and production);
   * ignored when it does not. See `docs/api-reference.md`.
   */
  attestation: z
    .object({
      keyId: z.string().min(1).max(100),
      attestationObject: z.string().min(1).max(20_000),
      challenge: z.string().min(1).max(100),
    })
    .optional(),
});

/**
 * Creates a guest — the first request a fresh iPhone install makes.
 *
 * No auth, by design: this is how someone with no account gets a token to play
 * with. What bounds it instead, in the order it is checked:
 *
 * 1. **The address limit.** First, and before the body is read, so a flood is
 *    refused at the cost of two Redis commands. Applies whether attestation is
 *    on or off.
 * 2. **App Attest**, where required: proof this is our app on a real device,
 *    and a key id that holds at most one live guest.
 *
 * **201** with the token, when it expires, and the guest's id — which is also
 * their analytics identity from this moment on.
 *
 * Hand-written rather than `withUser`, because there is no user yet.
 */
export async function POST(request: Request) {
  try {
    assertClientSupported(request);
    await assertUnderIpLimit('guests', clientIp(request), GUESTS_PER_IP_PER_HOUR);

    const body = await parseOptionalBody(request, bodySchema);
    const keyId = await attestedKeyId(body.attestation);

    const guest = await createGuest(keyId);

    return json(
      {
        token: guest.token,
        expiresAt: guest.expiresAt.toISOString(),
        user: { id: guest.user.id },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}
