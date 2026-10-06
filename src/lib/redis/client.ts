import Redis from 'ioredis';
import { env } from '@/env';
import { InternalServerError } from '@/lib/utils/errors';

/**
 * The one Redis connection this process holds.
 *
 * Memoised because several callers reach it — a route handler, a long-lived
 * worker, a server action — and a connection per call would exhaust the server's
 * client limit under exactly the load these features are for.
 *
 * Extracted from `transcript.store.ts`, which owned it when transcripts were the
 * only thing that needed Redis. A second module opening its own connection would
 * double that cost for no reason.
 */
let client: Redis | null = null;

export function redis(purpose: string): Redis {
  if (client) return client;

  const url = env.REDIS_URL;
  if (!url) {
    throw new InternalServerError(`REDIS_URL is not set, so ${purpose}.`);
  }

  client = new Redis(url, {
    // Bounded rather than disabled. A request that cannot reach Redis must fail
    // and be retried rather than waiting on a promise that may never settle —
    // but turning the offline queue off achieves that by failing every command
    // issued while the connection is still being established, which means the
    // first call after a cold start always fails. Timeouts give the same
    // guarantee without punishing the first caller.
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 2,
  });

  return client;
}

/** Test seam: drops the memoised connection so a fake can replace it. */
export function resetRedis(): void {
  client?.disconnect();
  client = null;
}
