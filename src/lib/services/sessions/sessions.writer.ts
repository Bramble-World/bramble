import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { storylineSessions, storyTurns, turnChoices } from '@/db/schema/tables';
import { Executor } from '../executor';
import { NewChoice, PublicSession, TurnWithChoices } from './sessions.types';

export async function insertSession(
  tx: Executor,
  userId: string,
  storylineId: string
): Promise<PublicSession> {
  const [session] = await tx.insert(storylineSessions).values({ userId, storylineId }).returning({
    id: storylineSessions.id,
    storylineId: storylineSessions.storylineId,
    lastActiveAt: storylineSessions.lastActiveAt,
  });
  return session;
}

/**
 * Writes a turn and the options offered on it.
 *
 * Two steps, because `story_turns.selected_choice_id` and `turn_choices.turn_id`
 * reference each other and there is no single atomic row for a turn with its
 * choices (invariants.md §5). They still commit together: a turn visible without
 * its options is a decision point the user cannot answer, and the partial unique
 * index would then block any attempt to open a replacement.
 *
 * `selectedChoiceId` starts null by construction — that is what "open" means,
 * and it is the column the index keys on.
 */
export async function insertTurnWithChoices(
  tx: Executor,
  sessionId: string,
  turnOrder: number,
  narrativeContent: string,
  choices: NewChoice[]
): Promise<TurnWithChoices> {
  const [turn] = await tx
    .insert(storyTurns)
    .values({ sessionId, turnOrder, narrativeContent })
    .returning({
      id: storyTurns.id,
      sessionId: storyTurns.sessionId,
      turnOrder: storyTurns.turnOrder,
      narrativeContent: storyTurns.narrativeContent,
      selectedChoiceId: storyTurns.selectedChoiceId,
      respondedAt: storyTurns.respondedAt,
    });

  // A closing beat can legitimately offer nothing, and drizzle rejects an empty
  // values().
  const written = choices.length
    ? await tx
        .insert(turnChoices)
        .values(
          choices.map((choice, orderIndex) => ({
            turnId: turn.id,
            label: choice.label,
            description: choice.description,
            orderIndex,
          }))
        )
        .returning({
          id: turnChoices.id,
          turnId: turnChoices.turnId,
          label: turnChoices.label,
          description: turnChoices.description,
          orderIndex: turnChoices.orderIndex,
        })
    : [];

  return { ...turn, choices: written };
}

/**
 * Records the user's answer, in one guarded statement.
 *
 * Every condition is in the WHERE clause rather than in a preceding read,
 * because a read-then-write here is a race: two clicks on the same turn would
 * both pass a prior check and the second would overwrite the first's answer and
 * timestamp. Affecting zero rows is therefore the *only* failure signal, and it
 * covers four distinct cases at once:
 *
 *   - the turn does not exist
 *   - it has already been answered           (idempotency, invariants.md §5)
 *   - the choice was never offered on it     (invariants.md §3, the hot path)
 *   - the session belongs to another user
 *
 * `respondedAt` is set in the same statement as `selectedChoiceId` because §4
 * requires them together — an answered turn with no timestamp reads as valid.
 *
 * The caller distinguishes the cases afterwards if it needs to; the write itself
 * deliberately does not care which one it was.
 */
export async function answerTurnGuarded(
  tx: Executor,
  userId: string,
  turnId: string,
  choiceId: string
): Promise<{ id: string; sessionId: string } | null> {
  const choiceWasOffered = exists(
    tx
      .select({ one: sql`1` })
      .from(turnChoices)
      .where(and(eq(turnChoices.id, choiceId), eq(turnChoices.turnId, turnId)))
  );

  const sessionIsOwned = exists(
    tx
      .select({ one: sql`1` })
      .from(storylineSessions)
      .where(
        and(eq(storylineSessions.id, storyTurns.sessionId), eq(storylineSessions.userId, userId))
      )
  );

  const [row] = await tx
    .update(storyTurns)
    .set({ selectedChoiceId: choiceId, respondedAt: new Date() })
    .where(
      and(
        eq(storyTurns.id, turnId),
        isNull(storyTurns.selectedChoiceId),
        choiceWasOffered,
        sessionIsOwned
      )
    )
    .returning({ id: storyTurns.id, sessionId: storyTurns.sessionId });

  return row ?? null;
}

/**
 * Moves a session's idle clock.
 *
 * The only place `lastActiveAt` is written, and it must stay that way. Touching
 * it anywhere else — on opening a turn, say — keeps a session looking active
 * forever so its arc summary never recomputes; touching it nowhere makes a
 * session look idle while someone is mid-decision, so the summary recomputes
 * underneath them. invariants.md §5 names the second failure by name.
 */
export async function touchSession(tx: Executor, sessionId: string): Promise<void> {
  await tx
    .update(storylineSessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(storylineSessions.id, sessionId));
}
