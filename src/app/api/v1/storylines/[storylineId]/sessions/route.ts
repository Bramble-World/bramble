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
const bodySchema = z.object({
  mode: z.enum(['resume', 'new']).optional(),
  /**
   * A beat from `GET /api/v1/world` to begin at.
   *
   * Validated as a uuid here so a malformed id is a 400 rather than reaching
   * Postgres and surfacing as a 500. Whether it is a beat of *this* storyline is
   * the service's question, and the answer is a 404.
   */
  fromEventId: z.string().uuid().optional(),
});

/**
 * Opens a storyline for play — the tap on "start" (screen 12).
 *
 * Resumes by default. Without that, a double tap, a retried request or a screen
 * restored from the background produces a second playthrough with its own
 * playhead, and the reader silently loses their place with nothing to report it.
 * `mode: "new"` keeps deliberate replays available, which is the other half of
 * what sessions are for.
 *
 * `fromEventId` is what makes the world screen's "play from here" work: the
 * reader picks one of the twenty moments and the new session's playhead lands on
 * that beat, so the story continues from it. Passing one always starts a fresh
 * playthrough — it overrides `mode`, because returning someone's half-finished
 * session when they asked to begin at a particular beat would silently ignore the
 * only thing they said.
 *
 * Returns the same `SessionView` as the resume probe, so the client has one
 * decoder and one branch for "what do I show now" whichever way it arrived.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const storylineId = uuidParam((await params).storylineId, 'storylineId');

  const { mode = 'resume', fromEventId } = await parseOptionalBody(request, bodySchema);

  const session = await sessions.resumeOrStart(user.id, storylineId, mode, fromEventId);
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
