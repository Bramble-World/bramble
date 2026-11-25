import { after } from 'next/server';
import { sessionView, type SessionView } from '@/lib/api/views';
import * as sessions from '@/lib/services/sessions/sessions.service';
import { nextStatusFor, nextStoryFor } from '@/lib/services/pool/next.service';
import {
  endingRecord,
  endingStatus,
  mayAttemptEnding,
  writeEnding,
  type EndingTrigger,
} from '@/lib/services/endings/ending.service';

/**
 * A session as every route returns it: the snapshot, and the next story once it
 * has ended. One place, so the resume probe, starting a story and starting the
 * next one cannot disagree about what a session looks like.
 *
 * An ended session still owed its ending gets another attempt at it here,
 * after the response: the app reads the session while it waits for the page,
 * and never calls `POST .../turn` again. The claim inside `writeEnding` keeps
 * the app's every-2 s reads (on any pod) to one model call between them.
 */
export async function sessionResponse(userId: string, sessionId: string): Promise<SessionView> {
  const snapshot = await sessions.sessionSnapshot(userId, sessionId);
  const ended = snapshot.state === 'ended';
  const [next, record] = ended
    ? await Promise.all([nextStoryFor(userId, sessionId), endingRecord(sessionId)])
    : [null, null];

  if (record && mayAttemptEnding(record)) scheduleEnding(userId, sessionId, 'read');

  return sessionView({
    id: snapshot.session.id,
    storylineId: snapshot.session.storylineId,
    state: snapshot.state,
    turnsAnswered: snapshot.turnsAnswered,
    turn: snapshot.turn,
    history: snapshot.history,
    endedAt: snapshot.session.endedAt,
    next,
    nextStatus: ended ? await nextStatusFor(userId, next) : null,
    ending: record?.ending ?? null,
    endingStatus: record ? endingStatus(record) : null,
    replyDueAt: snapshot.session.replyDueAt,
    replyDueKind: snapshot.session.replyDueKind,
  });
}

/**
 * Writes the session's ending after the response is sent, so nothing waits on
 * it. A no-op once written or while another attempt holds it; a failure is
 * logged by `writeEnding` and tried again by a later read or the ending sweep.
 */
export function scheduleEnding(userId: string, sessionId: string, trigger: EndingTrigger): void {
  after(() => writeEnding(userId, sessionId, { trigger }).catch(() => {}));
}
