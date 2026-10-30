import { z } from 'zod';
import { json } from '@/lib/api/respond';
import { parseOptionalBody } from '@/lib/api/params';
import { assertClientSupported } from '@/lib/api/client-version';
import { handleError } from '@/lib/utils/api.handler-errors';
import {
  clerkIdentity,
  requireClerkUserId,
  requireGuestFromHeader,
} from '@/lib/services/auth/auth.service';
import { claimGuest } from '@/lib/services/guests/guests.claim';

const bodySchema = z.object({
  /** How the reader signed up, for the `signup_completed` event. Never stored. */
  method: z.enum(['apple', 'passkey', 'email']).optional(),
});

/**
 * Saves a guest's story into an account — the step after signing in on the
 * save sheet.
 *
 * The one request that carries two identities: the Clerk session just signed
 * into, as `Authorization: Bearer`, and the guest whose story it is, as
 * `X-Bramble-Guest`. Both must verify, and the guest must still be live.
 *
 * `{ merged: false }` when the account is new — the guest's own row became the
 * account, so the user id the app already holds is unchanged. `{ merged: true }`
 * when the Clerk user already had an account: the story moved into it and the
 * guest's id no longer exists, so the app should re-read `GET /api/me` for the
 * id to use from now on. Either way the guest token stops working, and the
 * session id the app holds still names the same playthrough — so the reader
 * goes straight back to it, at beat 4.
 *
 * Hand-written rather than `withUser`, which resolves exactly one identity.
 */
export async function POST(request: Request) {
  try {
    assertClientSupported(request);

    // The Clerk session first: without it there is nothing to claim into, and a
    // request with no account should not learn whether its guest token is live.
    const clerkId = await requireClerkUserId(request);
    const guest = await requireGuestFromHeader(request);
    const { method } = await parseOptionalBody(request, bodySchema);

    const { merged, userId } = await claimGuest({
      guestId: guest.id,
      clerkId,
      fetchIdentity: () => clerkIdentity(clerkId),
      method,
    });

    return json({ merged, user: { id: userId } });
  } catch (error) {
    return handleError(error);
  }
}
