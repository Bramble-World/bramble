import { db } from '@/index';
import { claimNextTemplate, TEMPLATE_RECLAIM_AFTER_MS } from '@/lib/services/pool/pool.writer';
import { runTemplate } from '@/lib/services/pool/pool.job';

/**
 * A worker lane that writes pool stories, beside the import lanes.
 *
 * Same shape as `lane` in import-worker.ts — claim, run, repeat — and the same
 * rule for logs: ids, attempts, outcomes and durations, never an error message,
 * because a failure's cause can carry the answer.
 *
 * Bounded by an abort signal rather than a race: the model calls take one, so a
 * run that overstays is actually stopped, and the row is recorded as a failed
 * attempt like any other.
 */

const IDLE_POLL_MS = 5_000;

type Control = { draining: boolean };
type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function poolLane(id: number, control: Control, log: Log): Promise<void> {
  while (!control.draining) {
    let claim;
    try {
      claim = await claimNextTemplate(db);
    } catch {
      log('pool_claim_failed', { lane: id });
      await sleep(IDLE_POLL_MS);
      continue;
    }
    if (!claim) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const startedAt = Date.now();
    // Inside the reclaim window, so a stopped run is recorded before another
    // worker may take the row.
    const signal = AbortSignal.timeout(TEMPLATE_RECLAIM_AFTER_MS - 60_000);
    try {
      const outcome = await runTemplate(claim, { signal });
      log('template_finished', {
        lane: id,
        templateId: claim.id,
        attempt: claim.attempts,
        outcome,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Bookkeeping failed; the row is reclaimed once stale.
      log('template_errored', { lane: id, templateId: claim.id, attempt: claim.attempts });
    }
  }
}
