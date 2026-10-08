import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { importView } from '@/lib/api/views';
import * as imports from '@/lib/services/imports/imports.service';
import { importRequestSchema } from '@/lib/services/imports/imports.validate';

/**
 * The account's allowance and every conversation it has handed over.
 *
 * One request serves the whole import screen. `used` counts only `ready`; the
 * client computes what is left as `limit - used - pending`, reading `pending`
 * off the rows it already has, so there is no second number here that can
 * disagree with the list beside it.
 */
export const GET = withUser(async (user) => {
  const allowance = await imports.allowanceFor(user.id);

  return json({
    limit: allowance.limit,
    used: allowance.used,
    imports: allowance.imports.map(importView),
  });
});

/**
 * Hands over one conversation.
 *
 * Returns in milliseconds and does no extraction: the transcript is encrypted
 * into Redis, the row is left `queued` for a worker to claim, and the client
 * polls. Extracting inline would
 * mean a request held open for the length of a model call, which is the failure
 * that produced `UND_ERR_HEADERS_TIMEOUT` and three billed attempts for one
 * user action.
 *
 * **202** for a conversation newly accepted, **200** for one already known —
 * same body either way, so the client has one decoder and reads the status only
 * to decide whether anything changed. A re-send is expected rather than
 * exceptional: the Mac holds the durable copy of the transcript and re-sends
 * whenever it is unsure, so `conversationKey` has to make that free.
 *
 * Nothing from the body is logged here or anywhere below. The `imports` row
 * carries no message content, and the only place the transcript rests is the
 * encrypted store.
 */
export const POST = withUser(async (user, request) => {
  const body = await parseBody(request, importRequestSchema);

  const result = await imports.requestImport(user.id, body);

  return json({ import: importView(result.import) }, { status: result.accepted ? 202 : 200 });
});
