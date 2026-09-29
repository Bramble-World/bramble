import { z } from 'zod';
import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseOptionalBody, uuidParam } from '@/lib/api/params';
import { sessionView } from '@/lib/api/views';
import * as sessions from '@/lib/services/sessions/sessions.service';

type Params = { params: Promise<{ storylineId: string }> };

/**
 * An empty body is the ordinary case, so `mode` is optional and defaults to
 * resuming. A client that sends `{}` and one that sends nothing at all mean the
 * same thing and get the same answer.
 */
const bodySchema = z.object({ mode: z.enum(['resume', 'new']).optional() });

/**
 * Opens a storyline for play — the tap on "start" (screen 12).
 *
 * Resumes by default. Without that, a double tap, a retried request or a screen
 * restored from the background produces a second playthrough with its own
 * playhead, and the reader silently loses their place with nothing to report it.
 * `mode: "new"` keeps deliberate replays available, which is the other half of
 * what sessions are for.
 *
 * Returns the same `SessionView` as the resume probe, so the client has one
 * decoder and one branch for "what do I show now" whichever way it arrived.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const storylineId = uuidParam((await params).storylineId, 'storylineId');

  const { mode = 'resume' } = await parseOptionalBody(request, bodySchema);

  const session = await sessions.resumeOrStart(user.id, storylineId, mode);
  const snapshot = await sessions.sessionSnapshot(user.id, session.id);

  return json(
    {
      session: sessionView({
        id: snapshot.session.id,
        storylineId: snapshot.session.storylineId,
        state: snapshot.state,
        turnsAnswered: snapshot.turnsAnswered,
        turn: snapshot.turn,
      }),
    },
    { status: 201 }
  );
});
