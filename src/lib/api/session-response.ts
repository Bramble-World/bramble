import { sessionView, type SessionView } from '@/lib/api/views';
import * as sessions from '@/lib/services/sessions/sessions.service';
import { nextStoryFor } from '@/lib/services/pool/next.service';
import { storedEnding } from '@/lib/services/endings/ending.service';

/**
 * A session as every route returns it: the snapshot, and the next story once it
 * has ended. One place, so the resume probe, starting a story and starting the
 * next one cannot disagree about what a session looks like.
 */
export async function sessionResponse(userId: string, sessionId: string): Promise<SessionView> {
  const snapshot = await sessions.sessionSnapshot(userId, sessionId);
  const ended = snapshot.state === 'ended';
  const [next, ending] = ended
    ? await Promise.all([nextStoryFor(userId, sessionId), storedEnding(sessionId)])
    : [null, null];
  return sessionView({
    id: snapshot.session.id,
    storylineId: snapshot.session.storylineId,
    state: snapshot.state,
    turnsAnswered: snapshot.turnsAnswered,
    turn: snapshot.turn,
    history: snapshot.history,
    endedAt: snapshot.session.endedAt,
    next,
    ending,
  });
}
