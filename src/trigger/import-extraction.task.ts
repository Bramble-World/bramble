import { logger, task } from '@trigger.dev/sdk';
// Relative rather than the `@/` alias, like arc-sweep: this file is bundled by
// Trigger.dev rather than by Next, and a relative path works in both.
import { runImport } from '../lib/services/imports/import-runner';

/**
 * Turns one held transcript into a storyline.
 *
 * The payload is **exactly `{ importId }`** and that is a privacy decision, not
 * a minimalist one. Job payloads are stored by the queue, shown in a dashboard
 * and written to run logs; a transcript in there would outlive the thirty
 * minutes the ciphertext in Redis is allowed, in a system nobody thinks of as a
 * data store. The worker fetches the ciphertext itself and decrypts it in
 * memory.
 *
 * Nothing in this file logs anything derived from the transcript. The counts it
 * returns are about the row, not the content.
 */
export const importExtraction = task({
  id: 'import-extraction',
  // Extraction is one long model call. The transcript is held for 30 minutes and
  // a run that outlives that has nothing left to read, so there is no point
  // waiting longer than the data exists.
  maxDuration: 900,
  retry: {
    // Retries are safe: `claimImport` is a guarded update and the storyline
    // write is idempotent through the import row, so a second attempt either
    // finds the work done or redoes it exactly once. They only help while the
    // ciphertext is still in Redis, which the runner checks first.
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
  },
  run: async (payload: { importId: string }) => {
    const outcome = await runImport(payload.importId);

    // The id and the outcome, never the content. Returned as well as logged so
    // a run's result is visible in the dashboard without opening its logs.
    logger.info('import finished', { importId: payload.importId, outcome: outcome.status });
    return outcome;
  },
});
