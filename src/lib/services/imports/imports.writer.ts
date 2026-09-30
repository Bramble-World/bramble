import { and, eq, lt, or } from 'drizzle-orm';
import { imports } from '@/db/schema/tables';
import { Executor } from '../executor';
import { ImportStage, PublicImport } from './imports.types';

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
    .set({ status: 'queued', stage: null, failureCode: null, startedAt: null })
    .where(and(eq(imports.id, importId), eq(imports.status, 'failed')))
    .returning(returning);
  return row ?? null;
}

/**
 * How long a `running` import is left alone before another attempt may take it.
 *
 * Matched to the extraction task's `maxDuration`: a run cannot still be going
 * past its own ceiling, so anything older than this is a worker that died
 * without saying so. Shorter and two live attempts would overlap, which is the
 * duplicate extraction this guard exists to prevent; longer and a crashed run
 * blocks its own retry for no reason.
 */
export const RUN_RECLAIM_AFTER_MS = 900_000;

/**
 * Claims an import for a worker run.
 *
 * Returns false to everyone but the first caller. Trigger.dev delivers at least
 * once, so two attempts of the same job can overlap — and extraction is a model
 * call and a storyline write, which are the last things that should happen
 * twice.
 *
 * A `running` import is claimable only once it is older than a run can possibly
 * be. Accepting `running` unconditionally would make the guard useless, since
 * the second attempt would simply re-claim what the first is still working on;
 * refusing it entirely would leave a worker that died mid-run blocking its own
 * retry forever. The staleness check is what gives both.
 */
export async function claimImport(tx: Executor, importId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - RUN_RECLAIM_AFTER_MS);

  const [row] = await tx
    .update(imports)
    .set({ status: 'running', stage: 'reading', startedAt: new Date() })
    .where(
      and(
        eq(imports.id, importId),
        or(
          eq(imports.status, 'queued'),
          and(eq(imports.status, 'running'), lt(imports.startedAt, staleBefore))
        )
      )
    )
    .returning({ id: imports.id });
  return row !== undefined;
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
