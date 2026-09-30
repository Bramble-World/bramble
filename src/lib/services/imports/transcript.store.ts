import Redis from 'ioredis';
import { env } from '@/env';
import { InternalServerError } from '@/lib/utils/errors';
import { Transcript } from '../generation/extraction.service';
import { decryptTranscript, encryptTranscript } from './transcript.crypto';

/**
 * Where a transcript waits between the request that sends it and the worker
 * that reads it.
 *
 * Redis rather than Postgres, and that is the whole design. invariants.md §1
 * says message content never reaches a long-term store; a table would be one,
 * and would survive in backups, replicas and dumps long after the story had been
 * extracted. Here the value is ciphertext, it expires on its own in thirty
 * minutes, and the worker deletes it as soon as it has finished — so the window
 * in which the data exists at all is bounded by the platform rather than by
 * anybody remembering to clean up.
 *
 * The Mac is the durable copy. An expired or evicted key is not a lost
 * conversation, it is a retryable import: the client re-sends and
 * `conversationKey` keeps that idempotent.
 */

/**
 * Thirty minutes.
 *
 * Long enough that a queue backlog does not throw away work, short enough that
 * "we are holding your messages" stays a claim about minutes. It is also the
 * same window the stuck-job sweep uses, so an import cannot be alive while its
 * transcript is gone.
 */
export const TRANSCRIPT_TTL_SECONDS = 1800;

const key = (importId: string) => `import:${importId}`;

let client: Redis | null = null;

/**
 * The shared connection.
 *
 * Memoised because both a route handler and a long-lived worker reach it, and a
 * connection per call would exhaust the server's client limit under exactly the
 * load this feature is for.
 */
function redis(): Redis {
  if (client) return client;

  const url = env.REDIS_URL;
  if (!url) {
    throw new InternalServerError('REDIS_URL is not set, so transcripts cannot be held.');
  }

  client = new Redis(url, {
    // Bounded rather than disabled. A request that cannot reach Redis must fail
    // and be retried by the client rather than waiting on a promise that may
    // never settle — but turning the offline queue off achieves that by failing
    // every command issued while the connection is still being established,
    // which means the first import after a cold start always fails. Timeouts
    // give the same guarantee without punishing the first caller.
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 2,
  });

  return client;
}

/** Test seam: drops the memoised connection so a fake can replace it. */
export function resetTranscriptStore(): void {
  client?.disconnect();
  client = null;
}

/**
 * Holds a transcript for one import, encrypted, with an expiry set on write.
 *
 * The expiry is part of the same command rather than a second `EXPIRE`: a crash
 * between the two would leave a transcript in Redis with no TTL at all, which is
 * the one outcome this module exists to prevent.
 */
export async function putTranscript(
  importId: string,
  userId: string,
  transcript: Transcript
): Promise<void> {
  const envelope = encryptTranscript(transcript, importId, userId);
  await redis().set(key(importId), JSON.stringify(envelope), 'EX', TRANSCRIPT_TTL_SECONDS);
}

/**
 * Reads and decrypts a transcript.
 *
 * Returns null when the key is gone — expired, evicted, or already consumed.
 * That is an ordinary outcome rather than an error: it means the client should
 * re-send, and the caller turns it into a retryable failure.
 *
 * Deliberately does **not** delete. The worker may be retried, and a read that
 * consumed the only copy would turn one transient failure into a permanent one.
 * Deletion is explicit, at the end of the job, whichever way it went.
 */
export async function readTranscript(importId: string, userId: string): Promise<Transcript | null> {
  const raw = await redis().get(key(importId));
  if (raw === null) return null;

  return decryptTranscript<Transcript>(JSON.parse(raw), importId, userId);
}

/**
 * Deletes a transcript, on success or failure alike.
 *
 * Never throws. This runs in the worker's cleanup path, and a Redis hiccup here
 * must not turn a finished import into a failed one — the TTL is the backstop
 * and it is already set, so the worst case of a failed delete is that the
 * ciphertext expires on schedule instead of early.
 */
export async function dropTranscript(importId: string): Promise<void> {
  try {
    await redis().del(key(importId));
  } catch {
    // Intentionally swallowed. See above.
  }
}
