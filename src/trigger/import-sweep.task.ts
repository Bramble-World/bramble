import { schedules } from '@trigger.dev/sdk';
import { sweepStalledImports } from '../lib/services/imports/import-runner';
import { TRANSCRIPT_TTL_SECONDS } from '../lib/services/imports/transcript.store';

/**
 * Fails imports whose transcript has expired underneath them.
 *
 * The queue can drop a job — a deploy mid-run, an exhausted retry budget, a
 * worker that never came back — and nothing else would ever notice. The import
 * stays `queued` forever, the reader watches a spinner, and a slot stays
 * reserved against work that will never happen.
 *
 * Keyed to the transcript's own TTL rather than a number of its own, so the two
 * cannot drift: once the ciphertext is gone the job could not succeed even if it
 * ran, which makes the expiry the only honest deadline.
 */
const STALLED_AFTER_MS = TRANSCRIPT_TTL_SECONDS * 1000;

export const importSweep = schedules.task({
  id: 'import-sweep',
  cron: '*/10 * * * *',
  run: async () => sweepStalledImports(STALLED_AFTER_MS),
});
