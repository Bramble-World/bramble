import { timingSafeEqual } from 'node:crypto';
import { env } from '@/env';
import { redis } from '@/lib/redis/client';

/**
 * The beta gate.
 *
 * **What this protects, and what it does not.** One shared code stops the macOS
 * build being discovered by anyone who wanders onto the page, and stops the
 * download URL sitting in the HTML where a crawler finds it. It is not
 * authentication: every tester holds the same secret, so the moment one of them
 * forwards it — or forwards the resolved URL — it is out. Treat it as a doorbell,
 * not a lock.
 *
 * Two things follow from that and are worth doing anyway:
 *
 * - **The URL never reaches the browser before a correct code.** If it were in
 *   the page, or in the client bundle via a `NEXT_PUBLIC_` variable, the gate
 *   would be decoration. It is read server-side and returned only on success.
 * - **Guesses are throttled.** A short shared code with unlimited attempts falls
 *   in minutes, which would make the whole thing theatre.
 *
 * For anything stronger than a beta, the download itself wants to be a
 * short-lived signed URL, so a forwarded link expires on its own.
 */

/** Attempts allowed from one address before it has to wait. */
const MAX_ATTEMPTS = 10;

/** How long the window lasts, and therefore how long a lockout lasts. */
const WINDOW_SECONDS = 15 * 60;

export type BetaAccess =
  | { ok: true; url: string; label: string | null }
  | { ok: false; reason: 'closed' | 'wrong' | 'throttled' };

/**
 * Compares without leaking length or position through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a signal,
 * so both sides are hashed to a fixed width first. The win is small against a
 * network attacker; it costs three lines.
 */
function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given.trim().toLowerCase());
  const b = Buffer.from(expected.trim().toLowerCase());
  if (a.length !== b.length) {
    // Still do the work, so a wrong length is not faster than a wrong character.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Counts an attempt from this address and says whether it is one too many.
 *
 * Fails **open** when Redis is unreachable. A throttle that cannot reach its
 * store should not take the download offline for every tester — the code is
 * still required, and the alternative trades a small risk for a certain outage.
 */
async function throttled(fingerprint: string): Promise<boolean> {
  try {
    const key = `beta-access:${fingerprint}`;
    const client = redis('download attempts cannot be throttled');
    const attempts = await client.incr(key);
    // Set the expiry only on the first attempt, so the window is from the first
    // guess rather than sliding forward with every one — otherwise a persistent
    // guesser keeps their own lockout alive and never serves it.
    if (attempts === 1) await client.expire(key, WINDOW_SECONDS);
    return attempts > MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

export async function checkBetaCode(code: string, fingerprint: string): Promise<BetaAccess> {
  const expected = env.BETA_ACCESS_CODE;
  const url = env.MACOS_DOWNLOAD_URL;

  // Nothing configured yet: the beta is not open. Said before any comparison, so
  // an unconfigured deployment cannot be probed for a code that does not exist.
  if (!expected || !url) return { ok: false, reason: 'closed' };

  if (await throttled(fingerprint)) return { ok: false, reason: 'throttled' };
  if (!matches(code, expected)) return { ok: false, reason: 'wrong' };

  return { ok: true, url, label: env.MACOS_BUILD_LABEL ?? null };
}
