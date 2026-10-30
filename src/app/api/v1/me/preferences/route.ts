import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { z } from 'zod';
import * as userWriter from '@/lib/services/users/users.writer';
import { InternalServerError } from '@/lib/utils/errors';

const bodySchema = z.object({
  shareUsage: z.boolean(),
});

/**
 * The reader's own settings. One field so far.
 *
 * `shareUsage` is honoured on the server as well as in the app: every capture
 * checks it, so turning it off stops the events rather than merely hiding the
 * toggle. An opt-out that only silenced the client would be a promise quietly
 * broken on the other side of the network.
 *
 * `PUT` rather than `PATCH` because the body is the whole of the resource —
 * there is nothing here to partially update, and a client that sends it twice
 * gets the same answer.
 */
export const PUT = withUser(async (user, request) => {
  const { shareUsage } = await parseBody(request, bodySchema);

  // Keyed on the row id, not clerkId: a guest has no clerk id, and the opt-out
  // has to work from the first screen, before anyone signs up.
  const updated = await userWriter.updatePreferencesById(user.id, { shareUsage });
  if (!updated) throw new InternalServerError('That preference could not be saved.');

  return json({ shareUsage: updated.shareUsage });
});
