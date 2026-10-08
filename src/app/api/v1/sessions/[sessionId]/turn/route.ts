import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { uuidParam } from '@/lib/api/params';
import { energyView, turnView } from '@/lib/api/views';
import { advanceSession } from '@/lib/services/generation/turns.service';
import { energyFor } from '@/lib/services/sessions/energy.service';
import { TURN_DEADLINE_MS, withDeadline } from '@/lib/ai/deadline';

type Params = { params: Promise<{ sessionId: string }> };

/**
 * Brings a session to a playable state and returns what to show.
 *
 * The only paid endpoint, and deliberately the only one. "Settle what is owed,
 * then generate" is one operation rather than three ordered calls, because
 * consequences must be written before the next turn — the turn prompt reads the
 * canon they write — and publishing that as a sequence would make correctness
 * depend on a shipped binary doing three things in the right order. A client
 * that skipped the middle one would generate every later turn against stale
 * canon, with no error anywhere and quality quietly decaying.
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
  // `request.signal` joins it, so a reader who closes the app stops the spend
  // instead of paying for a turn nobody will read.
  const turn = await withDeadline(
    (signal) => advanceSession(user.id, sessionId, { signal }),
    TURN_DEADLINE_MS,
    request.signal
  );

  // Read after the turn is written, so the balance in this response already
  // reflects the point this request just spent. A client that rendered a stale
  // balance here would show a reader energy they no longer have.
  return json({ turn: turnView(turn), energy: energyView(await energyFor(user.id)) });
});
