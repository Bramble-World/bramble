import { sweepStalledImports } from '@/lib/services/imports/import-runner';
import { TRANSCRIPT_TTL_SECONDS } from '@/lib/services/imports/transcript.store';
import { runSweep } from './run';

/**
 * Fails imports whose transcript has expired underneath them. Every ten minutes.
 *
 * A worker can lose an import — a pod rescheduled mid-run, a retry budget spent,
 * a process that never came back — and nothing else would notice. The import
 * stays in flight forever, the reader watches a spinner, and a slot stays
 * reserved against work that will never happen.
 *
 * Keyed to the transcript's own TTL rather than a number of its own, so the two
 * cannot drift: once the ciphertext is gone the extraction could not succeed
 * even if it ran, which makes the expiry the only honest deadline.
 */
const STALLED_AFTER_MS = TRANSCRIPT_TTL_SECONDS * 1000;

void runSweep('import-sweep', () => sweepStalledImports(STALLED_AFTER_MS));
