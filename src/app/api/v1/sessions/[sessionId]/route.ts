import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { energyView, sessionView } from '@/lib/api/views';
import * as sessions from '@/lib/services/sessions/sessions.service';
import { energyFor } from '@/lib/services/sessions/energy.service';

type Params = { params: Promise<{ sessionId: string }> };

/**
 * Where a playthrough is — the resume probe.
 *
 * Free and instant: no model call, so a client can ask on every launch instead
 * of reconstructing state from whatever it managed to persist before it died.
 *
 * Three states, one remedy each. `awaiting_answer` carries the turn and renders
 * immediately; `awaiting_turn` means call `POST .../turn`; `blocked` means the
 * storyline is not playable. There is deliberately no fourth state for "answered
 * but consequences not yet written" — it is queryable, but the remedy is the
 * same call, and every state named here is a branch a shipped binary carries
 * forever.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const sessionId = uuidParam((await params).sessionId, 'sessionId');

  const snapshot = await sessions.sessionSnapshot(user.id, sessionId);

  return json({
    energy: energyView(await energyFor(user.id)),
    session: sessionView({
      id: snapshot.session.id,
      storylineId: snapshot.session.storylineId,
      state: snapshot.state,
      turnsAnswered: snapshot.turnsAnswered,
      turn: snapshot.turn,
      history: snapshot.history,
    }),
  });
});
