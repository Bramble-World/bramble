import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { env } from '@/env';
import { redis } from '@/lib/redis/client';
import { TURN_DEADLINE_MS } from '@/lib/ai/deadline';
import { GenerationTimeoutError } from '@/lib/utils/errors';

/**
 * A link from ChatGPT, sent twice, is written once.
 *
 * The app sends a link when it's tapped, and again if the first send never
 * got an answer (the app left, the network dropped), so a link can arrive
 * twice. Without this the second queued every story again. The same note from
 * the same account within `ONCE_SECONDS` gets the first one's answer; while
 * the first is still being sorted, the second waits for it.
 *
 * What's kept is a one-way fingerprint of the account and the note, never the
 * note, and the answer (an outcome and counts), both gone after 30 minutes.
 * Without Redis it simply doesn't dedupe: a repeat writes again, as before.
 */
export const ONCE_SECONDS = 30 * 60;

export type LinkStore = Pick<Redis, 'set' | 'get' | 'del'>;

const PENDING = 'pending';

/** The store links are remembered in: Redis where there is one, nowhere otherwise. */
export function linkStore(): LinkStore | null {
  return env.REDIS_URL ? redis('ChatGPT links sent twice are written twice') : null;
}

export function linkKey(userId: string, note: string): string {
  const digest = createHash('sha256').update(`${userId}\n${note.trim()}`).digest('hex');
  return `chatgpt-link:${digest}`;
}

/**
 * `work`'s answer, or the answer the same link already got. `keep` says which
 * answers are worth remembering: one that's cheap to work out again and
 * changes with time (the day's limit) is not.
 */
export async function once<T>(
  store: LinkStore | null,
  key: string,
  work: () => Promise<T>,
  {
    keep = () => true,
    waitMs = TURN_DEADLINE_MS,
    pollMs = 1_000,
  }: { keep?: (answer: T) => boolean; waitMs?: number; pollMs?: number } = {}
): Promise<T> {
  if (!store) return work();

  let claimed: boolean;
  try {
    claimed = (await store.set(key, PENDING, 'EX', ONCE_SECONDS, 'NX')) === 'OK';
  } catch {
    // Redis is down: write it, as if this were the first.
    return work();
  }

  if (claimed) {
    try {
      const answer = await work();
      if (keep(answer)) {
        await store.set(key, JSON.stringify(answer), 'EX', ONCE_SECONDS).catch(() => {});
      } else {
        await store.del(key).catch(() => {});
      }
      return answer;
    } catch (error) {
      // Failed: a repeat should try again, not wait on nothing.
      await store.del(key).catch(() => {});
      throw error;
    }
  }

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    let seen: string | null;
    try {
      seen = await store.get(key);
    } catch {
      return work();
    }
    // Gone: the first failed or wasn't kept, so this one writes.
    if (seen === null) return once(store, key, work, { keep, waitMs: until - Date.now(), pollMs });
    if (seen !== PENDING) return JSON.parse(seen) as T;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new GenerationTimeoutError();
}
