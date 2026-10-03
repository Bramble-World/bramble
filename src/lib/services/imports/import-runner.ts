import { db } from '@/index';
import { AppError, TranscriptExpiredError } from '@/lib/utils/errors';
import { extractStoryline } from '../generation/extraction.service';
import * as storylineReader from '../storylines/storylines.reader';
import * as reader from './imports.reader';
import * as writer from './imports.writer';
import { failureIsRetryable } from './imports.types';
import { track } from '@/lib/analytics/analytics';
import { dropTranscript, readTranscript } from './transcript.store';

/**
 * The body of the extraction job, kept out of the Trigger.dev file.
 *
 * Separated so it can be tested against a real database without a queue, which
 * is the only way the interesting parts of it — claiming, adoption on retry,
 * what happens to the ciphertext on each kind of failure — get exercised at all.
 *
 * **Nothing here logs a transcript, a message, or a model prompt.** The only
 * things that leave this function are an import id, a status and a storyline id.
 */

export type ImportOutcome = {
  status: 'ready' | 'failed' | 'skipped';
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

export async function runImport(importId: string): Promise<ImportOutcome> {
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

  // At-least-once delivery means two attempts can overlap. Extraction is a model
  // call and a storyline write, so losing this race has to mean doing nothing.
  if (!(await writer.claimImport(db, importId))) return { status: 'skipped' };

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
    await writer.markFailed(db, importId, code);

    if (failureIsRetryable(code)) {
      // Left in Redis on purpose. The spec says retries are allowed while the
      // key exists, and deleting here would make every retry fail on a missing
      // transcript instead of on whatever actually went wrong. The TTL is still
      // the backstop, so nothing outlives its thirty minutes either way.
      //
      // Rethrown so Trigger.dev schedules the retry rather than recording a
      // successful run that quietly failed.
      throw error;
    }

    // Terminal. Retrying would fail the same way and cost another model call, so
    // the ciphertext goes now rather than waiting out its expiry.
    await dropTranscript(importId);
    await reportImport(row, { status: 'failed', code, messageCount });
    return { status: 'failed', code };
  }
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
