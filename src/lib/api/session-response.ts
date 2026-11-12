import { sessionView, type SessionView } from '@/lib/api/views';
import * as sessions from '@/lib/services/sessions/sessions.service';
import { nextStoryFor } from '@/lib/services/pool/next.service';

/**
 * A session as every route returns it: the snapshot, and the next story once it
 * has ended. One place, so the resume probe, starting a story and starting the
 * next one cannot disagree about what a session looks like.
 */
export async function sessionResponse(userId: string, sessionId: string): Promise<SessionView> {
  const snapshot = await sessions.sessionSnapshot(userId, sessionId);
  const next = snapshot.state === 'ended' ? await nextStoryFor(userId, sessionId) : null;
  return sessionView({
    id: snapshot.session.id,
    storylineId: snapshot.session.storylineId,
    state: snapshot.state,
    turnsAnswered: snapshot.turnsAnswered,
    turn: snapshot.turn,
    history: snapshot.history,
    endedAt: snapshot.session.endedAt,
    next,
  });
}
