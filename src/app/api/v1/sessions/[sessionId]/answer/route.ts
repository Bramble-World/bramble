import { z } from 'zod';
import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody, uuidParam } from '@/lib/api/params';
import { turnView } from '@/lib/api/views';
import * as sessions from '@/lib/services/sessions/sessions.service';
import { NotFoundError } from '@/lib/utils/errors';

type Params = { params: Promise<{ sessionId: string }> };

const bodySchema = z.object({
  turnId: z.string().uuid(),
  choiceId: z.string().uuid(),
});

/**
 * Records the reader's decision — the tap on screen 14.
 *
 * Fast and separate from generation on purpose. Nothing here calls a model: it
 * is one guarded UPDATE and a session touch, so the tap is acknowledged in
 * milliseconds and the client can fire `POST .../turn` immediately and animate
 * over the top of it. That overlap is the whole latency budget of the loop.
 *
 * `turnId` in the body is the concurrency token, not a convenience. Without it a
 * screen restored from the background can answer a turn the reader never saw —
 * the id says *which* decision this was, and the guarded update refuses if it is
 * no longer the open one.
 *
 * Retrying is safe: `answerTurn` reconciles a repeat of the same choice into a
 * 200 rather than a 409, so a lost response cannot strand a client on an
 * operation that actually succeeded. A *different* choice is still a real 409.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const sessionId = uuidParam((await params).sessionId, 'sessionId');
  const body = await parseBody(request, bodySchema);

  // Proves the session is this reader's before the turn id is used for
  // anything. `answerTurn` is itself userId-scoped, but the session in the URL
  // and the turn in the body are two separate claims and both have to hold.
  const session = await sessions.getSession(user.id, sessionId);

  const turn = await sessions.answerTurn(user.id, body.turnId, body.choiceId);

  // A turn that is real and the reader's, but in a different session than the
  // URL named. Same answer as "no such turn": the client's model of where it is
  // is wrong either way, and naming the discrepancy would confirm the other
  // session exists.
  if (turn.sessionId !== session.id) throw new NotFoundError('Turn', body.turnId);

  return json({ turn: turnView(turn) });
});
