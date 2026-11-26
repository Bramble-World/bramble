import { z } from 'zod';
import { withAccount } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { acceptInvite, firstNameSchema } from '@/lib/services/invites/invites.service';

type Params = { params: Promise<{ code: string }> };

const bodySchema = z.object({
  /** How this player wants to be known in the inviter's story. */
  firstName: firstNameSchema,
});

/**
 * Accepts an invite: makes the story for two, one side each, each player's
 * next story. Once: 409 `INVITE_USED` after someone has (the same player again
 * gets the same answer), 410 `INVITE_EXPIRED` after 7 days, 409 `OWN_INVITE`
 * for your own.
 */
export const POST = withAccount(async (user, request, { params }: Params) => {
  const { firstName } = await parseBody(request, bodySchema);
  const { duetId } = await acceptInvite(user.id, (await params).code, firstName);
  return json({ duet: { id: duetId } }, { status: 201 });
}, 'Sign up to play a story together.');
