import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { importView } from '@/lib/api/views';
import * as imports from '@/lib/services/imports/imports.service';

type Params = { params: Promise<{ importId: string }> };

/**
 * Where one import has got to.
 *
 * What the client polls every few seconds while an import is `queued` or
 * `running`, so it is deliberately the cheapest route in the API: one indexed
 * row read, no Redis, no model, no joins.
 *
 * Carries no message content — the row it reads has none.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const importId = uuidParam((await params).importId, 'importId');

  // Scoped getter: throws NotFoundError for an import that is not this
  // reader's, so "not yours" and "no such thing" are the same 404.
  const row = await imports.getImportForUser(user.id, importId);

  return json({ import: importView(row) });
});
