import { and, asc, eq, isNull, lt, max } from 'drizzle-orm';
import { db } from '@/index';
import { storylineSessions, storyTurns, turnChoices } from '@/db/schema/tables';
import { Executor } from '../executor';
import { PublicSession, TurnWithChoices } from './sessions.types';

const sessionColumns = {
  id: storylineSessions.id,
  storylineId: storylineSessions.storylineId,
  lastActiveAt: storylineSessions.lastActiveAt,
};

export async function getSession(userId: string, sessionId: string): Promise<PublicSession | null> {
  const [session] = await db
    .select(sessionColumns)
    .from(storylineSessions)
    .where(and(eq(storylineSessions.userId, userId), eq(storylineSessions.id, sessionId)))
    .limit(1);
  return session ?? null;
}

export async function listSessions(userId: string, storylineId: string): Promise<PublicSession[]> {
  return db
    .select(sessionColumns)
    .from(storylineSessions)
    .where(
      and(eq(storylineSessions.userId, userId), eq(storylineSessions.storylineId, storylineId))
    )
    .orderBy(asc(storylineSessions.createdAt));
}

/**
 * The turn awaiting an answer, if there is one.
 *
 * Since PR #23 a partial unique index guarantees there is at most one, which is
 * what lets "present the next beat" be a get-or-create instead of a convention.
 */
export async function getOpenTurn(
  tx: Executor,
  sessionId: string
): Promise<TurnWithChoices | null> {
  const turn = await tx.query.storyTurns.findFirst({
    where: { sessionId, selectedChoiceId: { isNull: true } },
    with: { choices: { orderBy: { orderIndex: 'asc' } } },
  });
  return turn ?? null;
}

export async function getTurn(tx: Executor, turnId: string): Promise<TurnWithChoices | null> {
  const turn = await tx.query.storyTurns.findFirst({
    where: { id: turnId },
    with: { choices: { orderBy: { orderIndex: 'asc' } } },
  });
  return turn ?? null;
}

export async function nextTurnOrder(tx: Executor, sessionId: string): Promise<number> {
  const [row] = await tx
    .select({ highest: max(storyTurns.turnOrder) })
    .from(storyTurns)
    .where(eq(storyTurns.sessionId, sessionId));
  return (row?.highest ?? 0) + 1;
}

/**
 * Sessions nobody has touched for a while.
 *
 * This is the whole reason `lastActiveAt` is denormalised: idleness is inferred
 * by an indexed scan over one column rather than by joining and aggregating
 * every session's turns. Nothing marks a session as finished — people just stop.
 *
 * Deliberately not scoped to a user, because the caller is a background sweep
 * rather than a request.
 */
export async function findIdleSessions(idleSince: Date): Promise<PublicSession[]> {
  return db
    .select(sessionColumns)
    .from(storylineSessions)
    .where(lt(storylineSessions.lastActiveAt, idleSince))
    .orderBy(asc(storylineSessions.lastActiveAt));
}

/** Whether a choice was one of the options offered on that turn. */
export async function choiceBelongsToTurn(
  tx: Executor,
  turnId: string,
  choiceId: string
): Promise<boolean> {
  const [row] = await tx
    .select({ id: turnChoices.id })
    .from(turnChoices)
    .where(and(eq(turnChoices.id, choiceId), eq(turnChoices.turnId, turnId)))
    .limit(1);
  return row !== undefined;
}

/** Used only to tell an already-answered turn apart from one that never existed. */
export async function turnIsUnanswered(tx: Executor, turnId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: storyTurns.id })
    .from(storyTurns)
    .where(and(eq(storyTurns.id, turnId), isNull(storyTurns.selectedChoiceId)))
    .limit(1);
  return row !== undefined;
}
