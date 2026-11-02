import { z } from 'zod';
import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { setPushEnabled } from '@/lib/services/push/push.service';

const bodySchema = z.object({ enabled: z.boolean() });

/**
 * The notifications switch in settings. Honoured here rather than on the phone,
 * because the server is what sends them. Accepted from a guest too, who has
 * nothing to turn off, so the app needs no special case.
 */
export const PUT = withUser(async (user, request) => {
  const { enabled } = await parseBody(request, bodySchema);
  await setPushEnabled(user.id, enabled);
  return json({ enabled });
});
