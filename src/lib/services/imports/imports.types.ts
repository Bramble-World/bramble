export type ImportStatus = 'queued' | 'running' | 'ready' | 'failed';
export type ImportStage = 'reading' | 'writing' | 'casting';

/**
 * How many conversations an account may ever import.
 *
 * Ever, not concurrently. The client mirrors this for its own UI, but the
 * server is the authority — a limit the client applies to itself is not a limit,
 * and this endpoint is reachable by anything holding a bearer token.
 */
export const IMPORT_LIMIT = 3;

/**
 * An import as every reader projects it.
 *
 * Carries nothing from the transcript and never will. The row it comes from has
 * no message content either, so there is no field here that was dropped for
 * safety — the safety is in the schema.
 */
export type PublicImport = {
  id: string;
  conversationKey: string;
  status: ImportStatus;
  stage: ImportStage | null;
  storylineId: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Which failures the client should re-send after, and which it should stop on.
 *
 * The distinction is whether trying again could plausibly produce a different
 * result. A transcript that expired will be re-sent and read; a transcript the
 * model could not make a story out of will fail the same way forever, and
 * retrying it costs the reader a slot's worth of waiting and us a model call.
 */
const RETRYABLE_FAILURES = new Set([
  'TRANSCRIPT_EXPIRED',
  'GENERATION_FAILED',
  'GENERATION_TIMEOUT',
  'UPSTREAM_BUSY',
  'INTERNAL_SERVER_ERROR',
]);

export function failureIsRetryable(code: string): boolean {
  return RETRYABLE_FAILURES.has(code);
}

/**
 * How many times one import may be run before it is given up on.
 *
 * Counted on the row rather than in the worker, because the attempt that gives
 * up is rarely the attempt that started: a pod can be rescheduled mid-run, and a
 * budget held in memory would reset exactly when it matters. Three matches what
 * the queue used to be configured for, and every attempt has to fit inside the
 * thirty minutes the ciphertext is held — after that there is nothing to retry
 * against, so the stall sweep ends it regardless of attempts left.
 */
export const MAX_IMPORT_ATTEMPTS = 3;

/**
 * How long a failed import waits before a worker may take it again.
 *
 * Doubling from five seconds, which is what the queue's retry policy did. The
 * delay is the entire point of retrying an upstream that is busy or
 * rate-limited: a requeued row is claimable the instant it is written, so
 * without a gap the three attempts are spent as fast as three calls can fail.
 */
export function retryDelayMs(attempts: number): number {
  return 5_000 * 2 ** Math.max(0, attempts - 1);
}
