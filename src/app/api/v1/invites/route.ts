import { z } from 'zod';
import { withAccount } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { createInvite, firstNameSchema } from '@/lib/services/invites/invites.service';

const bodySchema = z.object({
  /** How the inviter wants to be known in the other player's story. */
  firstName: firstNameSchema,
});

/**
 * Makes an invite to a story for two, to share as a link. Accounts only:
 * the story is made for an account, and so is the other side.
 *
 * At most 5 open at once and 10 made a day: past either, 429 `RATE_LIMITED`.
 */
export const POST = withAccount(async (user, request) => {
  const { firstName } = await parseBody(request, bodySchema);
  const invite = await createInvite(user.id, firstName);
  return json({ invite }, { status: 201 });
}, 'Sign up to invite someone to a story.');
