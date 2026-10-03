import { RateLimitError } from '@/lib/utils/errors';
import * as reader from './sessions.reader';

/**
 * How much a reader may play, and when more becomes available.
 *
 * Playing a turn is the only thing in this product that spends money on demand,
 * and until now nothing bounded it: any authenticated reader could run the model
 * as often as they liked, and the first signal would have been the bill.
 *
 * A **sliding window**, not a daily reset. Each turn costs a point that returns
 * exactly 24 hours after it was spent, so energy trickles back through the day
 * rather than arriving in a lump at midnight. That avoids the cliff a reset
 * creates — run out at nine in the evening and you have something back by
 * morning rather than nothing until it flips — and it avoids a timezone decision
 * entirely, since there is no "start of day" to define. Nothing in this codebase
 * has ever needed one.
 *
 * **Derived, never stored.** The balance is counted from `story_turns` itself
 * rather than from a column that is incremented. Three things follow for free:
 * a generation that fails writes no turn and therefore charges nothing, without
 * a refund path to get wrong; the count cannot drift from reality, because the
 * number of turns *is* the number of turns; and the moment a point returns is
 * exact rather than approximated.
 */

/**
 * Turns a reader may create in any 24-hour period.
 *
 * A volume limit, not a cost one — and the difference matters. A turn late in a
 * long playthrough costs considerably more than an early one, because the
 * consequence stage that follows it sends the whole timeline. Defending this
 * number properly needs the token counts that `GenerationMeta` currently
 * captures and discards.
 */
export const TURN_ENERGY_PER_DAY = 20;

export const ENERGY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Energy = {
  /** 0..limit. */
  remaining: number;
  limit: number;
  /**
   * When the next point returns, or null when nothing is spent.
   *
   * The oldest turn in the window plus the window — the instant it ages out and
   * its point comes back. Null at a full balance, because there is nothing
   * regenerating to report.
   */
  resetsAt: Date | null;
};

export async function energyFor(userId: string): Promise<Energy> {
  const since = new Date(Date.now() - ENERGY_WINDOW_MS);
  const { used, oldest } = await reader.turnsCreatedSince(userId, since);

  // Clamped at zero: the check cannot be held in a transaction across a model
  // call, so a burst of concurrent requests can overshoot the cap slightly. A
  // negative balance is a true statement that no client should have to render.
  const remaining = Math.max(0, TURN_ENERGY_PER_DAY - used);

  return {
    remaining,
    limit: TURN_ENERGY_PER_DAY,
    resetsAt: oldest ? new Date(oldest.getTime() + ENERGY_WINDOW_MS) : null,
  };
}

/**
 * Refuses a turn when the reader has nothing left to spend.
 *
 * `RateLimitError` carries `retryAfter` in seconds, which `handleError` turns
 * into both a body field and a `Retry-After` header through a structural check —
 * so the wire contract this satisfies was already documented and already had
 * tests; the only thing missing was anything that threw it.
 *
 * At least one second, because a `Retry-After: 0` invites an immediate retry
 * that will fail for the same reason.
 */
export async function assertEnergy(userId: string): Promise<Energy> {
  const energy = await energyFor(userId);
  if (energy.remaining > 0) return energy;

  const seconds = energy.resetsAt
    ? Math.max(1, Math.ceil((energy.resetsAt.getTime() - Date.now()) / 1000))
    : 1;

  throw new RateLimitError(seconds);
}
