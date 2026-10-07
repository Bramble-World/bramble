import { db } from '@/index';
import { ImportLimitReachedError, NotFoundError } from '@/lib/utils/errors';
import * as reader from './imports.reader';
import * as writer from './imports.writer';
import { IMPORT_LIMIT, PublicImport } from './imports.types';
import { ImportRequest, assertTranscriptIsUsable } from './imports.validate';
import { putTranscript } from './transcript.store';

/**
 * Accepting conversations, counting what an account has spent, and reporting
 * where an extraction has got to.
 *
 * Nothing here touches a message beyond handing the transcript to the store,
 * which encrypts it on the way in. The `imports` row carries no content, so a
 * mistake in this file cannot put message text in Postgres — which is the point
 * of splitting the transcript away from the record of it.
 */

export type Allowance = {
  limit: number;
  used: number;
  imports: PublicImport[];
};

/**
 * The account's allowance and every import it has made.
 *
 * `used` counts only `ready`, matching the contract the client renders against.
 * Imports still in flight are visible in the list with their own status, so the
 * client computes remaining slots as `limit - used - pending` and does not need
 * a second number here that could disagree with the rows beside it.
 */
export async function allowanceFor(userId: string): Promise<Allowance> {
  const all = await reader.listImports(userId);

  return {
    limit: IMPORT_LIMIT,
    used: all.filter((row) => row.status === 'ready').length,
    imports: all,
  };
}

export async function getImportForUser(userId: string, importId: string): Promise<PublicImport> {
  const row = await reader.getImport(userId, importId);
  if (!row) throw new NotFoundError('Import', importId);
  return row;
}

/**
 * Takes a conversation, reserves a slot for it, and holds the transcript for the
 * worker.
 *
 * Returns `accepted: false` when an import for this conversation already exists
 * and has not failed. That is the idempotent path, and it is what makes the
 * Mac's re-send safe: the client is the durable copy of the transcript, so it
 * re-sends whenever it is unsure, and a second POST must not cost a second slot
 * or start a second extraction.
 *
 * Ordered deliberately, and the order is why there is no queue. The row commits
 * first and the transcript is written second, which means a worker can only ever
 * claim a row whose ciphertext is already there — a broker would have to be told
 * about the row separately, and that message is the thing that gets lost. The
 * queued row *is* the queue. A failure writing the transcript marks the import
 * failed with a retryable code rather than leaving it claimable against a
 * transcript that does not exist.
 */
export async function requestImport(
  userId: string,
  request: ImportRequest
): Promise<{ import: PublicImport; accepted: boolean }> {
  assertTranscriptIsUsable(request);

  const claimed = await db.transaction(async (tx) => {
    // Serialises this account's imports for the rest of the transaction. The
    // allowance is a count, and a count read without a lock is a race: two
    // requests for the last slot both see two spent, both insert, and the
    // account ends up with four conversations.
    await reader.lockAccount(tx, userId);

    const existing = await reader.findByConversationKey(tx, userId, request.conversationKey);

    if (existing && existing.status !== 'failed') {
      return { import: existing, accepted: false };
    }

    if (existing) {
      // A failed import being re-sent. It is not counted against the allowance
      // it is already part of — otherwise a reader whose third conversation
      // failed could never retry it — but the rest of the account still is, so
      // retrying cannot be used to exceed the limit.
      if ((await reader.countSlotsHeld(tx, userId, existing.id)) >= IMPORT_LIMIT) {
        throw new ImportLimitReachedError(IMPORT_LIMIT);
      }

      const requeued = await writer.requeueImport(tx, existing.id);
      // Null means a worker finished it between the read and the update. Its
      // result is the truthful answer, and re-running would spend a model call
      // to overwrite a storyline the reader may already be playing.
      if (!requeued) {
        return { import: existing, accepted: false };
      }
      return { import: requeued, accepted: true };
    }

    if ((await reader.countSlotsHeld(tx, userId)) >= IMPORT_LIMIT) {
      throw new ImportLimitReachedError(IMPORT_LIMIT);
    }

    return {
      import: await writer.insertImport(tx, userId, request.conversationKey),
      accepted: true,
    };
  });

  if (!claimed.accepted) return claimed;

  try {
    await putTranscript(claimed.import.id, userId, request.transcript);
  } catch (error) {
    // The row is claimable and there is nothing for a worker to read, so say so
    // now rather than leaving the reader watching a spinner until the stall
    // sweep notices.
    // Retryable: the client still holds the transcript.
    await writer.markFailed(db, claimed.import.id, 'TRANSCRIPT_EXPIRED');
    throw error;
  }

  return claimed;
}
