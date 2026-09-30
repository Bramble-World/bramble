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
