import { after } from 'next/server';
import { withUser } from '@/lib/api/with-user';
import { scheduleEnding } from '@/lib/api/session-response';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { turnView } from '@/lib/api/views';
import { readerEnergy } from '@/lib/api/energy';
import { advanceSession } from '@/lib/services/generation/turns.service';
import { TURN_DEADLINE_MS, withDeadline } from '@/lib/ai/deadline';
import { clientShowsEndings } from '@/lib/api/client-version';

type Params = { params: Promise<{ sessionId: string }> };

/**
 * Brings a session to a playable state and returns what to show.
 *
 * The only paid endpoint, and deliberately the only one. "Write the next beat,
 * and settle what the last choice changed" is one operation rather than ordered
 * calls, because publishing it as a sequence would make correctness depend on
 * a shipped binary doing things in the right order. A client that skipped one
 * would generate every later turn against stale canon, with no error anywhere
 * and quality quietly decaying.
 *
 * The last choice's consequences are settled after the response (`after`), so
 * the player waits for the beat alone. The beat is written from the playthrough,
 * which already holds that choice; canon catches up before the beat after.
 *
 * Convergent, so the same URL is the loop, the resume and the retry. Calling it
 * twice is safe: consequences are claimed transactionally and the turn is
 * get-or-create behind the one-open-turn index, so the second call finds the
 * work done and costs a SELECT rather than a model call.
 *
 * The response body is the whole of screens 13 and 14 — narrative and choices
 * arrive together, so the client holds the decision before the reader has
 * finished reading the beat above it.
 *
 * Client policy this is designed for: single-flight per session, jittered
 * backoff, at most three attempts, then a button. Never two concurrent.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const sessionId = uuidParam((await params).sessionId, 'sessionId');

  // A server deadline we own, rather than undici's 300s ceiling — which is a
  // failure mode with the worst properties available: no status code and three
  // automatic retries, so one request bills three model calls. This converts
  // that into one paid call and one clean, safely retryable 504.
  //
  // The app leaving does NOT stop it. A beat takes 10-20 s, and a reader who
  // locks the phone or switches apps meanwhile drops the request; stopping
  // then threw the work away, and they came back to "try again" and the whole
  // wait again (seen in production, 2026-11-13: every failure was the app
  // leaving). Finished, the beat is saved, and the app's next call gets it
  // instantly from the open turn, at no extra cost.
  const turn = await withDeadline(
    // The Mac app can't show an ending, so its stories don't get one.
    (signal) =>
      advanceSession(user.id, sessionId, {
        signal,
        endings: clientShowsEndings(request),
        later: (work) => after(work),
      }),
    TURN_DEADLINE_MS
  );

  // Read after the turn is written, so the balance in this response already
  // reflects the point this request just spent. A client that rendered a stale
  // balance here would show a reader energy they no longer have.
  //
  // Null for a guest: their limit is beats, not energy, and past it this route
  // answers 403 SIGNUP_REQUIRED instead of 429. See `assertMayPlay`.
  // The ending page is written after the response, so the last beat isn't held
  // up by it. A no-op once written. A failure is tried again by the app's next
  // read of the session, and by the ending sweep.
  if (turn.isEnding) scheduleEnding(user.id, sessionId, 'turn');

  return json({ turn: turnView(turn), energy: await readerEnergy(user) });
});
