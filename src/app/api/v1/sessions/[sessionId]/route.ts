import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { sessionResponse } from '@/lib/api/session-response';
import { readerEnergy } from '@/lib/api/energy';

type Params = { params: Promise<{ sessionId: string }> };

/**
 * Where a playthrough is — the resume probe.
 *
 * Free and instant: no model call, so a client can ask on every launch instead
 * of reconstructing state from whatever it managed to persist before it died.
 *
 * Four states, one remedy each. `awaiting_answer` carries the turn and renders
 * immediately; `awaiting_turn` means call `POST .../turn`; `blocked` means the
 * storyline is not playable; `ended` carries the ending as the turn and, in
 * `next`, the story to go on to (`POST .../next`). There is deliberately no state
 * for "answered but consequences not yet written" — the remedy is the same call,
 * and every state named here is a branch a shipped binary carries forever.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const sessionId = uuidParam((await params).sessionId, 'sessionId');

  return json({
    // Null for a guest, who has beats rather than energy. See readerEnergy.
    energy: await readerEnergy(user),
    session: await sessionResponse(user.id, sessionId),
  });
});
