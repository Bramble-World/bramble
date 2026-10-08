import { db } from '@/index';
import { AppError, TranscriptExpiredError } from '@/lib/utils/errors';
import { extractStoryline } from '../generation/extraction.service';
import * as storylineReader from '../storylines/storylines.reader';
import * as reader from './imports.reader';
import * as writer from './imports.writer';
import { ClaimedImport } from './imports.writer';
import { MAX_IMPORT_ATTEMPTS, failureIsRetryable } from './imports.types';
import { track } from '@/lib/analytics/analytics';
import { dropTranscript, readTranscript } from './transcript.store';

/**
 * The body of one extraction, kept out of the worker loop.
 *
 * Separated so it can be tested against a real database without a worker, which
 * is the only way the interesting parts of it — claiming, adoption on retry,
 * what happens to the ciphertext on each kind of failure — get exercised at all.
 *
 * **Nothing here logs a transcript, a message, or a model prompt.** The only
 * things that leave this function are an import id, a status and a storyline id.
 */

export type ImportOutcome = {
  /**
   * `retrying` is its own outcome rather than a thrown error. The worker loop is
   * the retry mechanism now, and a requeued import is neither finished nor a
   * failure of the run that handed it back — reporting it as either would make
   * the failure rate count attempts instead of imports.
   */
  status: 'ready' | 'failed' | 'skipped' | 'retrying';
  storylineId?: string;
  /** Present only when failed. A code, never a message. */
  code?: string;
};

/**
 * Turns an error into the code the client will branch on.
 *
 * Deliberately narrow: anything that is not one of our own typed errors becomes
 * `INTERNAL_SERVER_ERROR` rather than carrying its message onto the row. The
 * messages available here come from the model or from an exception wrapping the
 * prompt, and the prompt is the transcript.
 */
function codeOf(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR';
}

/**
 * Runs one import to a terminal state, or hands it back for another attempt.
 *
 * `claim` is passed by the worker, which has already taken the row as part of
 * selecting it — claiming again would fail its own staleness check and the run
 * would skip itself. Callers without a claim take one here, which is the same
 * predicate either way.
 */
export async function runImport(importId: string, claim?: ClaimedImport): Promise<ImportOutcome> {
  const row = await reader.getImportForWorker(importId);
  // Deleted between enqueue and run — the account was removed, most likely.
  // Nothing to fail, and nothing to retry.
  if (!row) return { status: 'skipped' };
  if (row.status === 'ready') return { status: 'ready', storylineId: row.storylineId ?? undefined };

  // A previous attempt that wrote a storyline and died before recording it.
  // Adopting it is both cheaper and more correct than extracting again: the
  // reader gets the story that already exists rather than a second copy of the
  // same conversation, and nobody pays for a second model call.
  if (row.storylineId) {
    const storyline = await storylineReader.getStoryline(row.userId, row.storylineId);
    if (storyline?.status === 'ready') {
      await writer.markReady(db, importId, storyline.id);
      await dropTranscript(importId);
      // No message count: this branch adopts a storyline a previous attempt
      // wrote and never reads a transcript.
      await reportImport(row, { status: 'ready' });
      return { status: 'ready', storylineId: storyline.id };
    }
  }

  // Two attempts can overlap — a stale row reclaimed, or an id run directly.
  // Extraction is a model call and a storyline write, so losing this race has to
  // mean doing nothing.
  const attempts = claim?.attempts ?? (await writer.claimImport(db, importId));
  if (attempts === null) return { status: 'skipped' };

  // Hoisted so the catch can report it: `transcript` is scoped to the try, and a
  // failure after extraction began should still say how much was being read.
  let messageCount: number | undefined;

  try {
    const transcript = await readTranscript(importId, row.userId);
    // Expired, evicted, or never written. The Mac holds the durable copy, so
    // this is a re-send rather than a loss.
    if (!transcript) throw new TranscriptExpiredError();
    messageCount = transcript.messages.length;

    await writer.markStage(db, importId, 'casting');

    const storyline = await extractStoryline(row.userId, transcript, {
      onStorylineCreated: (storylineId) => writer.attachStoryline(db, importId, storylineId),
    });

    await writer.markStage(db, importId, 'writing');
    await writer.markReady(db, importId, storyline.id);
    await dropTranscript(importId);
    await reportImport(row, { status: 'ready', messageCount });

    return { status: 'ready', storylineId: storyline.id };
  } catch (error) {
    const code = codeOf(error);

    if (failureIsRetryable(code) && attempts < MAX_IMPORT_ATTEMPTS) {
      // Back to `queued`, not to `failed`. Only a claimable row gets another
      // attempt, and `failed` is not claimable — marking it so is what made the
      // old queue's retries silently do nothing.
      await writer.requeueForRetry(db, importId, attempts);

      // The ciphertext is left in Redis on purpose. Retries are allowed while
      // the key exists, and deleting here would make every retry fail on a
      // missing transcript instead of on whatever actually went wrong. The TTL
      // is still the backstop, so nothing outlives its thirty minutes.
      return { status: 'retrying' };
    }

    // Terminal, either in kind or because the budget is spent. Retrying would
    // fail the same way and cost another model call, so the ciphertext goes now
    // rather than waiting out its expiry.
    await writer.markFailed(db, importId, code);
    await dropTranscript(importId);
    await reportImport(row, { status: 'failed', code, messageCount });
    return { status: 'failed', code };
  }
}

/**
 * Records an import whose run was abandoned part-way through.
 *
 * For the worker's per-import timeout, which is the one failure the run itself
 * cannot report: the promise is still out there, so nothing inside `runImport`
 * will ever reach its own catch. Without this the row sits `running` until the
 * reclaim window passes, and the reader watches a spinner for fifteen minutes.
 *
 * Treated as a timeout, which is retryable, so a genuinely slow extraction gets
 * another attempt rather than being failed on the first one that ran long.
 */
export async function abandonImport(importId: string, attempts: number): Promise<ImportOutcome> {
  if (attempts < MAX_IMPORT_ATTEMPTS) {
    await writer.requeueForRetry(db, importId, attempts);
    return { status: 'retrying' };
  }

  const code = 'GENERATION_TIMEOUT';
  await writer.markFailed(db, importId, code);
  await dropTranscript(importId);

  // Reported only on the terminal attempt, matching the catch above: counting
  // every abandoned attempt would make the failure rate the share of attempts
  // that failed rather than the share of imports that did.
  const row = await reader.getImportForWorker(importId);
  if (row) await reportImport(row, { status: 'failed', code });

  return { status: 'failed', code };
}

/**
 * Fails imports that have been in flight longer than their transcript is held.
 *
 * Bounded by the TTL rather than by a timeout of its own: once the ciphertext
 * has expired the job cannot succeed, so anything still `queued` or `running`
 * past that point is waiting on something that no longer exists. Without this a
 * dropped job leaves the reader watching a spinner forever, and leaves a slot
 * reserved against an import that will never finish.
 */
/**
 * Sends `import_completed` for an import that has just reached a terminal state.
 *
 * Deliberately not called on the retryable rethrow: that import is not finished,
 * and counting it would make the failure rate the number of *attempts* that
 * failed rather than the number of imports that did. Nor on the already-ready
 * short circuit, which is a repeat delivery rather than a transition.
 */
async function reportImport(
  row: { userId: string; createdAt: Date },
  outcome: { status: 'ready' | 'failed'; code?: string; messageCount?: number }
): Promise<void> {
  await track(row.userId, {
    name: 'import_completed',
    properties: {
      status: outcome.status,
      ...(outcome.code ? { failure_code: outcome.code } : {}),
      // Queued to terminal, which is what a reader actually waits through —
      // not the run time, which excludes however long it sat in the queue.
      duration_ms: Date.now() - row.createdAt.getTime(),
      ...(outcome.messageCount !== undefined ? { message_count: outcome.messageCount } : {}),
    },
  });
}

export async function sweepStalledImports(olderThanMs: number): Promise<{ failed: number }> {
  const stalled = await reader.findStalled(new Date(Date.now() - olderThanMs));

  for (const row of stalled) {
    await writer.markFailed(db, row.id, 'TRANSCRIPT_EXPIRED');
    await dropTranscript(row.id);
    // The sweep is a terminal state like any other, and the one that is easiest
    // to miss: an import nobody ever came back for. Leaving it uncounted would
    // make the success rate flatter than it is.
    await reportImport(row, { status: 'failed', code: 'TRANSCRIPT_EXPIRED' });
  }

  return { failed: stalled.length };
}
