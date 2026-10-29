import type Redis from 'ioredis';
import { redis } from '@/lib/redis/client';
import { RateLimitError } from '@/lib/utils/errors';

/**
 * Guests created per client address per hour.
 *
 * Creating a guest is free and unauthenticated by design — it is the first
 * thing a fresh install does — so this is what stands between the endpoint and a
 * script minting accounts, each of which can then spend three model calls. Ten
 * is generous for the honest cases it has to allow: a household, an office or a
 * phone carrier's NAT sharing one address, and someone reinstalling while they
 * try the app. App Attest (where it is required) is the per-device limit; this
 * is the per-network one, and it applies whether attestation is on or off.
 */
export const GUESTS_PER_IP_PER_HOUR = 10;

/**
 * Attestation challenges per client address per hour.
 *
 * Higher than the guest limit because a client may need a fresh challenge for a
 * retry, and lower than unbounded because each one is a Redis key — cheap, but
 * not free to let anyone mint.
 */
export const CHALLENGES_PER_IP_PER_HOUR = 30;

const HOUR_SECONDS = 60 * 60;

/** The two commands the limiter needs, so a test can hand it a fake. */
export type CounterStore = Pick<Redis, 'set' | 'incr' | 'ttl'>;

/**
 * The address a request came from, as the ingress saw it.
 *
 * Production sits behind Porter's nginx ingress, which appends the connecting
 * address to `X-Forwarded-For`. The first entry is the client as the outermost
 * proxy received it; anything after it was added by a hop we run. A client can
 * put anything it likes in a header it sends, so this is a limiter key and never
 * an identity — spoofing it moves a caller into a different bucket, which is the
 * ceiling of what it can buy.
 *
 * `unknown` rather than a throw when nothing is present (a local request with no
 * proxy in front): those requests then share one bucket, which is the safe way
 * round to be wrong.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = request.headers.get('x-real-ip')?.trim();
  return real || 'unknown';
}

/**
 * Counts one more request from this address in this bucket, and refuses once
 * the count passes `limit` within the window.
 *
 * A fixed window: the first request creates the key with its expiry, and every
 * later one increments it until the key expires. `SET NX EX` then `INCR`, rather
 * than `INCR` then `EXPIRE`, so a process that dies between the two commands
 * leaves a key that still expires — the other order can leave a counter with no
 * expiry, which would lock an address out forever.
 *
 * Refuses with `RATE_LIMITED` and the seconds left in the window as
 * `Retry-After`. Nothing about the address is logged or stored past the window.
 */
export async function assertUnderIpLimit(
  bucket: string,
  ip: string,
  limit: number,
  windowSeconds = HOUR_SECONDS,
  store: CounterStore = redis('guest creation cannot be rate-limited')
): Promise<void> {
  const key = `ratelimit:${bucket}:${ip}`;

  await store.set(key, 0, 'EX', windowSeconds, 'NX');
  const count = await store.incr(key);
  if (count <= limit) return;

  const ttl = await store.ttl(key);
  throw new RateLimitError(ttl > 0 ? ttl : windowSeconds);
}
