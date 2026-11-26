import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { readInvite } from '@/lib/services/invites/invites.service';

type Params = { params: Promise<{ code: string }> };

/**
 * What an invite is, for the screen that asks whether to accept it: the
 * inviter's first name, when it expires, and whether it's still open. Guests
 * too: they see who's inviting before they're asked to sign up.
 */
export const GET = withUser(async (_user, _request, { params }: Params) => {
  const invite = await readInvite((await params).code);
  return json({ invite });
});
