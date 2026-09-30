import { db } from '@/index';
import { AppError, TranscriptExpiredError } from '@/lib/utils/errors';
import { extractStoryline } from '../generation/extraction.service';
import * as storylineReader from '../storylines/storylines.reader';
import * as reader from './imports.reader';
import * as writer from './imports.writer';
import { failureIsRetryable } from './imports.types';
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
      return { status: 'ready', storylineId: storyline.id };
    }
  }

  // At-least-once delivery means two attempts can overlap. Extraction is a model
  // call and a storyline write, so losing this race has to mean doing nothing.
  if (!(await writer.claimImport(db, importId))) return { status: 'skipped' };

  try {
    const transcript = await readTranscript(importId, row.userId);
    // Expired, evicted, or never written. The Mac holds the durable copy, so
    // this is a re-send rather than a loss.
    if (!transcript) throw new TranscriptExpiredError();

    await writer.markStage(db, importId, 'casting');

    const storyline = await extractStoryline(row.userId, transcript, {
      onStorylineCreated: (storylineId) => writer.attachStoryline(db, importId, storylineId),
    });

    await writer.markStage(db, importId, 'writing');
    await writer.markReady(db, importId, storyline.id);
    await dropTranscript(importId);

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
export async function sweepStalledImports(olderThanMs: number): Promise<{ failed: number }> {
  const stalled = await reader.findStalled(new Date(Date.now() - olderThanMs));

  for (const row of stalled) {
    await writer.markFailed(db, row.id, 'TRANSCRIPT_EXPIRED');
    await dropTranscript(row.id);
  }

  return { failed: stalled.length };
}
