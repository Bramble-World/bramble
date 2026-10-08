/**
 * A deadline of our own for a model call.
 *
 * `Generator.run` has accepted an `AbortSignal` since it was written and nothing
 * in the app ever passed one, so every generation ran until the HTTP client gave
 * up. That client is undici, whose `headersTimeout` is 300 seconds, and it is the
 * worst possible thing to be bounded by: the request fails with no status code,
 * no response body, and — because the AI SDK sees a retryable transport error —
 * three automatic attempts. One user action billed three model calls. That is not
 * hypothetical; it is how a real extraction failed, with nothing in the database
 * to explain it.
 *
 * A deadline we own converts that into one paid call and one clean, honest error
 * the caller can retry on purpose. Every generation in this app is get-or-create
 * against database state, so a retry after a timeout either finds the finished
 * work or does it exactly once.
 *
 * The number is a budget, not a measurement: a turn takes seconds, so 60 leaves
 * enormous headroom while still landing far inside the transport ceiling.
 */
export const TURN_DEADLINE_MS = 60_000;

/**
 * Runs `work` with a signal that aborts after `ms`.
 *
 * Takes a callback rather than returning a signal so the timer is always cleared
 * — a dangling `setTimeout` keeps the process alive, which in a serverless
 * handler means paying for an idle invocation and in a long-lived server means a
 * slow leak under load.
 *
 * An external signal can be passed too, so a client hanging up cancels the work
 * instead of leaving it to run for a response nobody will read. `AbortSignal.any`
 * is the standard composition; whichever fires first wins.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number = TURN_DEADLINE_MS,
  external?: AbortSignal
): Promise<T> {
  const timer = new AbortController();
  const id = setTimeout(() => timer.abort(), ms);

  const signal = external ? AbortSignal.any([timer.signal, external]) : timer.signal;

  try {
    return await work(signal);
  } finally {
    clearTimeout(id);
  }
}
