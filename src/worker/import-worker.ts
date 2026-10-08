import { db } from '@/index';
import { env } from '@/env';
import { abandonImport, runImport } from '@/lib/services/imports/import-runner';
import { RUN_RECLAIM_AFTER_MS, claimNextImport } from '@/lib/services/imports/imports.writer';
import type { ClaimedImport } from '@/lib/services/imports/imports.writer';

/**
 * The import worker: a long-running process that extracts whatever is queued.
 *
 * The queued row *is* the queue. There is no broker, no job payload and no
 * second copy of anything — a worker claims the oldest claimable `imports` row
 * with `for update skip locked` and runs it. That is deliberate rather than
 * minimal: a queue record is a store too, and the one thing this system must not
 * do is keep a transcript anywhere but the encrypted store it has a TTL on. An
 * id is the whole payload because an id is all a queue is allowed to know.
 *
 * **Nothing derived from a transcript is logged here.** Every line this file
 * writes carries ids, counts, durations and status strings. There is no error
 * message in any of them: the messages reachable from an extraction failure come
 * from the model or from an exception wrapping the prompt, and the prompt is the
 * conversation.
 */

/** How long to wait before asking again, once there is nothing to claim. */
const IDLE_POLL_MS = 2_000;

/**
 * How long one import may run before the lane gives up on it.
 *
 * Matched to `RUN_RECLAIM_AFTER_MS`, because they are two halves of the same
 * promise: a run is abandoned at exactly the point another worker is allowed to
 * assume it died. If this were the longer of the two, two live attempts would
 * overlap; if it were much shorter, a row would be abandoned while still
 * claimed by a lane that is working on it.
 */
const IMPORT_TIMEOUT_MS = RUN_RECLAIM_AFTER_MS;

/**
 * Shared between the lanes, and the only state they have.
 *
 * Passed in rather than held at module scope so the loop can be started, stopped
 * and started again inside one process — which is what a test of the shutdown
 * path has to do, and what module-level flags quietly make impossible.
 */
type Control = {
  /** Set by SIGTERM, and by a lane that has lost track of a run. Lanes stop claiming. */
  draining: boolean;
  /** Non-zero when the process is ending because something broke, not because it was asked to. */
  exitCode: number;
};

function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  // One line, one JSON object: these go to the platform's log collector, which
  // indexes fields and not prose.
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs an import, or resolves to null if it takes longer than a run may take.
 *
 * The losing promise is not cancelled, because it cannot be — an in-flight model
 * call has no abort path from here. That is why a timeout drains the process
 * rather than freeing the lane: the only way left to guarantee one runner per
 * import is to end the process that lost track of one. The platform restarts it.
 */
async function runWithTimeout(claim: ClaimedImport): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), IMPORT_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([runImport(claim.id, claim).then((o) => o.status), timeout]);
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One lane: claim, run, repeat.
 *
 * Concurrency is N of these rather than one loop claiming batches, so a slow
 * extraction holds up only itself. `skip locked` is what makes them independent
 * — each lane is handed a different row, including lanes in other replicas, so
 * scaling out needs no coordination and no partitioning.
 */
async function lane(id: number, control: Control): Promise<void> {
  while (!control.draining) {
    let claim: ClaimedImport | null;

    try {
      claim = await claimNextImport(db);
    } catch {
      // Postgres is unreachable or the statement failed. No id to report and
      // nothing to do about it here; back off a poll and try again rather than
      // spinning on a database that is restarting.
      log('claim_failed', { lane: id });
      await sleep(IDLE_POLL_MS);
      continue;
    }

    if (!claim) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const startedAt = Date.now();
    log('import_claimed', { lane: id, importId: claim.id, attempt: claim.attempts });

    try {
      const status = await runWithTimeout(claim);

      if (status === null) {
        // Drain before recording, so the row is not handed to another worker
        // while this process is still able to claim.
        control.draining = true;
        control.exitCode = 1;
        const outcome = await abandonImport(claim.id, claim.attempts);
        log('import_abandoned', {
          lane: id,
          importId: claim.id,
          attempt: claim.attempts,
          durationMs: Date.now() - startedAt,
          outcome: outcome.status,
        });
        return;
      }

      log('import_finished', {
        lane: id,
        importId: claim.id,
        attempt: claim.attempts,
        status,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // `runImport` handles its own failures and returns them, so reaching here
      // means the bookkeeping itself failed — the database went away between the
      // claim and the write. The row stays `running` and becomes claimable again
      // once it is stale, which is the case the reclaim window is for.
      //
      // The error is deliberately not logged. It can carry a prompt in a
      // `cause` chain, and no extraction detail is worth a transcript in a log
      // aggregator.
      log('import_errored', {
        lane: id,
        importId: claim.id,
        attempt: claim.attempts,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

/**
 * Stops claiming and lets whatever is running finish.
 *
 * In-flight imports are not interrupted, because interrupting one wastes a model
 * call that has already been paid for and leaves a row to be reclaimed fifteen
 * minutes later. The platform's termination grace period is the real bound here:
 * it has to be at least as long as one import may take, or the pod is killed
 * mid-extraction anyway and the grace period is decoration.
 *
 * Resolves to the exit code the process should use, and does not exit itself —
 * the entrypoint owns that, so this stays callable from a test.
 */
export async function main(): Promise<number> {
  const control: Control = { draining: false, exitCode: 0 };
  const concurrency = env.IMPORT_WORKER_CONCURRENCY;

  const stop = (signal: string) => {
    if (control.draining) return;
    control.draining = true;
    log('draining', { signal });
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');

  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  log('worker_started', { concurrency, idlePollMs: IDLE_POLL_MS, timeoutMs: IMPORT_TIMEOUT_MS });

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => lane(i, control)));
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }

  log('worker_stopped', { exitCode: control.exitCode });
  return control.exitCode;
}
