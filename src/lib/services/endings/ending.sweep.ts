import { and, asc, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/index';
import { storylineSessions } from '@/db/schema/tables';
import type { Generator } from '@/lib/ai';
import { ENDING_LEASE_MS, ENDING_MAX_ATTEMPTS, writeEnding } from './ending.service';

/**
 * How long after a story ends the sweep leaves it to the turn route and the
 * app's own reads, which normally write the ending within seconds.
 */
export const ENDING_SWEEP_GRACE_MS = 5 * 60_000;

/** Endings written per run, at most. Each is one model call, or two. */
export const ENDING_SWEEP_BATCH = 20;

/** Endings written at once within a run. */
const LANES = 4;

/**
 * The ended sessions still owed an ending that an attempt may start on now:
 * ended more than the grace ago, under the attempt cap, and not attempted
 * within the lease. Oldest first, so nothing waits behind newer ones.
 */
export async function endingsOwed(limit = ENDING_SWEEP_BATCH) {
  const graceStart = sql`now() - make_interval(secs => ${ENDING_SWEEP_GRACE_MS / 1000})`;
  const leaseStart = sql`now() - make_interval(secs => ${ENDING_LEASE_MS / 1000})`;
  return db
    .select({ sessionId: storylineSessions.id, userId: storylineSessions.userId })
    .from(storylineSessions)
    .where(
      and(
        isNotNull(storylineSessions.endedAt),
        isNull(storylineSessions.ending),
        lt(storylineSessions.endedAt, graceStart),
        lt(storylineSessions.endingAttempts, ENDING_MAX_ATTEMPTS),
        or(
          isNull(storylineSessions.endingAttemptedAt),
          lt(storylineSessions.endingAttemptedAt, leaseStart)
        )
      )
    )
    .orderBy(asc(storylineSessions.endedAt))
    .limit(limit);
}

/**
 * Writes the endings nothing else got to. Every five minutes.
 *
 * The turn route writes an ending after the last beat's response, and any read
 * of the session tries again while it's missing — but an `after()` cut short by
 * a deploy leaves no trace, and a reader who never reopens the story never
 * reads it. This is the backstop. Each write claims its attempt like any other
 * (`writeEnding`), so a run overlapping a read starts nothing twice, and the
 * cap holds here too.
 */
export async function sweepEndings(
  deps: { generator?: Generator; limit?: number } = {}
): Promise<Record<string, number>> {
  const owed = await endingsOwed(deps.limit);
  const result = { owed: owed.length, written: 0, failed: 0, skipped: 0 };

  const queue = [...owed];
  await Promise.all(
    Array.from({ length: LANES }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const ending = await writeEnding(next.userId, next.sessionId, {
            generator: deps.generator,
            trigger: 'sweep',
          });
          if (ending) result.written += 1;
          else result.skipped += 1;
        } catch {
          // Logged by `writeEnding`, and tried again on a later run until the cap.
          result.failed += 1;
        }
      }
    })
  );
  return result;
}
