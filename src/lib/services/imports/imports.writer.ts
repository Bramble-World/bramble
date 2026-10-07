import { and, eq, sql } from 'drizzle-orm';
import { imports } from '@/db/schema/tables';
import { Executor } from '../executor';
import { ImportStage, MAX_IMPORT_ATTEMPTS, PublicImport, retryDelayMs } from './imports.types';

const returning = {
  id: imports.id,
  conversationKey: imports.conversationKey,
  status: imports.status,
  stage: imports.stage,
  storylineId: imports.storylineId,
  failureCode: imports.failureCode,
  createdAt: imports.createdAt,
  updatedAt: imports.updatedAt,
};

export async function insertImport(
  tx: Executor,
  userId: string,
  conversationKey: string
): Promise<PublicImport> {
  const [row] = await tx
    .insert(imports)
    .values({ userId, conversationKey, status: 'queued' })
    .returning(returning);
  return row;
}

/**
 * Puts a failed import back in the queue.
 *
 * Clears the previous failure and the storyline that was never written, so the
 * row reads as a fresh attempt rather than as a failure that is somehow also
 * running. Guarded on the current status being `failed`, so a retry that races a
 * job which has just succeeded cannot drag a `ready` import backwards.
 */
export async function requeueImport(tx: Executor, importId: string): Promise<PublicImport | null> {
  const [row] = await tx
    .update(imports)
    .set({
      status: 'queued',
      stage: null,
      failureCode: null,
      startedAt: null,
      // A re-send is a fresh conversation as far as the retry budget goes.
      // Without this an import that exhausted its attempts could never run
      // again, however many times the client handed it back.
      attempts: 0,
      nextAttemptAt: null,
    })
    .where(and(eq(imports.id, importId), eq(imports.status, 'failed')))
    .returning(returning);
  return row ?? null;
}

/**
 * How long a `running` import is left alone before another attempt may take it.
 *
 * Matched to the worker's per-import timeout: a run cannot still be going past
 * its own ceiling, so anything older than this is a worker that died without
 * saying so. Shorter and two live attempts would overlap, which is the duplicate
 * extraction this guard exists to prevent; longer and a crashed run blocks its
 * own retry for no reason.
 */
export const RUN_RECLAIM_AFTER_MS = 900_000;

/**
 * What makes an import claimable, as one predicate.
 *
 * Written once and used by both entry points — the worker's "claim whatever is
 * next" and the by-id claim — because two copies of this condition is two places
 * for the duplicate-extraction guard to be wrong. Takes the table's SQL
 * qualifier so the by-next variant can read it through its own alias.
 *
 * Column helpers are deliberately not used: drizzle renders them unqualified
 * inside a subquery, which binds them to the outer table. The same trap cost a
 * silently-zero count in `playthroughsForEvents`, and here it would mean
 * claiming a row that does not satisfy the predicate at all.
 */
function claimable(qualifier: string, staleBefore: Date) {
  const col = (name: string) => sql.raw(`"${qualifier}"."${name}"`);

  return sql`${col('attempts')} < ${MAX_IMPORT_ATTEMPTS} and (
    (
      ${col('status')} = 'queued'
      and (${col('next_attempt_at')} is null or ${col('next_attempt_at')} <= now())
    )
    or (${col('status')} = 'running' and ${col('started_at')} < ${staleBefore})
  )`;
}

/** The row state a claim establishes. One run, one owner, one more attempt spent. */
function claimed() {
  return {
    status: 'running' as const,
    stage: 'reading' as const,
    startedAt: new Date(),
    nextAttemptAt: null,
    attempts: sql`${imports.attempts} + 1`,
  };
}

/** What a worker needs to run an import, and nothing else. */
export type ClaimedImport = {
  id: string;
  userId: string;
  attempts: number;
};

/**
 * Takes the next claimable import, or null when there is nothing to do.
 *
 * Selection and claim are one statement on purpose. Reading a candidate and then
 * claiming it would have every idle worker pick the same oldest row and all but
 * one throw their round trip away; `for update skip locked` instead hands each
 * worker a different row, which is what lets replicas be added without them
 * fighting over the head of the queue.
 *
 * Carries the attempt number this claim consumed, so the caller knows whether a
 * failure has any budget left without re-reading the row, and the `userId` from
 * the row rather than from anything a request supplied.
 */
export async function claimNextImport(tx: Executor): Promise<ClaimedImport | null> {
  const staleBefore = new Date(Date.now() - RUN_RECLAIM_AFTER_MS);

  const [row] = await tx
    .update(imports)
    .set(claimed())
    .where(
      sql`"imports"."id" = (
        select "claimable"."id" from "imports" "claimable"
        where ${claimable('claimable', staleBefore)}
        order by "claimable"."created_at"
        for update skip locked
        limit 1
      )`
    )
    .returning({ id: imports.id, userId: imports.userId, attempts: imports.attempts });

  return row ?? null;
}

/**
 * Claims one named import for a run, returning the attempt number it consumed.
 *
 * Null to everyone but the first caller. Two attempts of the same import can
 * overlap — a reclaimed stale row, or a caller handed an id directly — and
 * extraction is a model call and a storyline write, which are the last things
 * that should happen twice.
 *
 * A `running` import is claimable only once it is older than a run can possibly
 * be. Accepting `running` unconditionally would make the guard useless, since
 * the second attempt would simply re-claim what the first is still working on;
 * refusing it entirely would leave a worker that died mid-run blocking its own
 * retry forever. The staleness check is what gives both.
 */
export async function claimImport(tx: Executor, importId: string): Promise<number | null> {
  const staleBefore = new Date(Date.now() - RUN_RECLAIM_AFTER_MS);

  const [row] = await tx
    .update(imports)
    .set(claimed())
    .where(and(eq(imports.id, importId), claimable('imports', staleBefore)))
    .returning({ attempts: imports.attempts });
  return row?.attempts ?? null;
}

/**
 * Puts a failed attempt back in the queue, after a delay.
 *
 * The retryable path. The row goes back to `queued` rather than to `failed`,
 * because `failed` is not claimable and marking it so is what made the old
 * queue's retries do nothing at all: every attempt after the first found a
 * failed row, declined to claim it, and recorded a successful no-op.
 *
 * The failure code is cleared with it. A `queued` row carrying the reason its
 * last attempt died would show the reader a failure for an import that is still
 * going to run, and the client branches on status alone.
 */
export async function requeueForRetry(
  tx: Executor,
  importId: string,
  attempts: number
): Promise<void> {
  await tx
    .update(imports)
    .set({
      status: 'queued',
      stage: null,
      failureCode: null,
      startedAt: null,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
    })
    .where(and(eq(imports.id, importId), eq(imports.status, 'running')));
}

/** Moves the progress marker. Only meaningful while running. */
export async function markStage(tx: Executor, importId: string, stage: ImportStage): Promise<void> {
  await tx
    .update(imports)
    .set({ stage })
    .where(and(eq(imports.id, importId), eq(imports.status, 'running')));
}

/**
 * Records which storyline this import is building, while it is still building it.
 *
 * Written as soon as the storyline row exists rather than at the end, so a
 * worker that dies mid-extraction leaves a trail. Without it, a crash between
 * "storyline written" and "import marked ready" is indistinguishable from a
 * crash before either — and the retry pays for a second extraction and leaves
 * the reader with the same conversation twice.
 */
export async function attachStoryline(
  tx: Executor,
  importId: string,
  storylineId: string
): Promise<void> {
  await tx.update(imports).set({ storylineId }).where(eq(imports.id, importId));
}

/**
 * Marks an import finished and records the storyline it became.
 *
 * Takes an executor so the caller can commit this in the same transaction as
 * the storyline write: the spec's rule is that a slot is used *only* when the
 * import is ready, and a storyline that exists without its import marked ready
 * would be a conversation the reader spent and can spend again.
 */
export async function markReady(
  tx: Executor,
  importId: string,
  storylineId: string
): Promise<void> {
  await tx
    .update(imports)
    .set({ status: 'ready', stage: null, storylineId, failureCode: null })
    .where(eq(imports.id, importId));
}

/**
 * Records a failure as a code.
 *
 * A code and never a message. The only messages available here come from the
 * model or from an exception wrapping the prompt, and the prompt is the
 * transcript — so free text on this row is the one way message content could
 * reach Postgres by accident.
 */
export async function markFailed(
  tx: Executor,
  importId: string,
  failureCode: string
): Promise<void> {
  await tx
    .update(imports)
    .set({ status: 'failed', stage: null, failureCode })
    .where(eq(imports.id, importId));
}
