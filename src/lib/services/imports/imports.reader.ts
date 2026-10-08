import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/index';
import { imports, users } from '@/db/schema/tables';
import { Executor } from '../executor';
import { PublicImport } from './imports.types';

const columns = {
  id: imports.id,
  conversationKey: imports.conversationKey,
  status: imports.status,
  stage: imports.stage,
  storylineId: imports.storylineId,
  failureCode: imports.failureCode,
  createdAt: imports.createdAt,
  updatedAt: imports.updatedAt,
};

/**
 * Statuses that occupy one of the account's slots.
 *
 * `failed` is absent on purpose: a failure releases its slot, so a reader whose
 * extraction blew up is not punished for it. `ready` counts as spent, and
 * `queued`/`running` count as reserved, which is what stops three simultaneous
 * requests from each seeing an empty allowance.
 */
export const SLOT_HOLDING = ['queued', 'running', 'ready'] as const;

export async function listImports(userId: string): Promise<PublicImport[]> {
  return db
    .select(columns)
    .from(imports)
    .where(eq(imports.userId, userId))
    .orderBy(desc(imports.createdAt));
}

/** Scoped by userId, so an id from a URL can never reach another account's row. */
export async function getImport(userId: string, importId: string): Promise<PublicImport | null> {
  const [row] = await db
    .select(columns)
    .from(imports)
    .where(and(eq(imports.userId, userId), eq(imports.id, importId)))
    .limit(1);
  return row ?? null;
}

/**
 * The import the worker is about to run, looked up by id alone.
 *
 * The only unscoped read here, and it has to be: the job payload carries an
 * `importId` and nothing else, deliberately, so that a queue record leaks no
 * account identity. The `userId` it returns is what every subsequent call is
 * scoped by, and it comes from the row rather than from the job.
 */
export async function getImportForWorker(
  importId: string
): Promise<(PublicImport & { userId: string }) | null> {
  const [row] = await db
    .select({ ...columns, userId: imports.userId })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1);
  return row ?? null;
}

export async function findByConversationKey(
  tx: Executor,
  userId: string,
  conversationKey: string
): Promise<PublicImport | null> {
  const [row] = await tx
    .select(columns)
    .from(imports)
    .where(and(eq(imports.userId, userId), eq(imports.conversationKey, conversationKey)))
    .limit(1);
  return row ?? null;
}

/**
 * How many slots this account is holding, optionally ignoring one import.
 *
 * `excludeImportId` is for the retry path: a failed import being re-sent must
 * not be counted against the allowance it is already part of, or the reader
 * could never retry their third conversation.
 */
export async function countSlotsHeld(
  tx: Executor,
  userId: string,
  excludeImportId?: string
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(imports)
    .where(
      and(
        eq(imports.userId, userId),
        inArray(imports.status, [...SLOT_HOLDING]),
        excludeImportId ? ne(imports.id, excludeImportId) : undefined
      )
    );

  return row?.n ?? 0;
}

/**
 * Takes a per-account lock for the duration of the caller's transaction.
 *
 * The allowance is a count, and a count read outside a lock is a race: two
 * requests for the last slot both see two used, both insert, and the account
 * ends up with four conversations. Locking the `users` row serialises just this
 * account's imports rather than all of them, and it is released when the
 * transaction ends however it ends.
 */
export async function lockAccount(tx: Executor, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

/**
 * Imports that have been queued or running longer than the transcript is held.
 *
 * Bounded by the TTL rather than by a timeout of its own: once the ciphertext is
 * gone the job cannot succeed, so anything still in flight past that point is
 * waiting for something that no longer exists.
 */
export async function findStalled(
  olderThan: Date
): Promise<Array<{ id: string; userId: string; createdAt: Date }>> {
  return db
    .select({ id: imports.id, userId: imports.userId, createdAt: imports.createdAt })
    .from(imports)
    .where(and(inArray(imports.status, ['queued', 'running']), lt(imports.createdAt, olderThan)));
}
