import { and, eq, exists, isNull, lt, sql } from 'drizzle-orm';
import {
  events,
  storylineSessions,
  storyTurns,
  turnChoices,
  turnSurfaces,
} from '@/db/schema/tables';
import { Executor } from '../executor';
import { NewTurn, PublicSession } from './sessions.types';

export async function insertSession(
  tx: Executor,
  userId: string,
  storylineId: string,
  startedFromEventId?: string
): Promise<PublicSession> {
  const [session] = await tx
    .insert(storylineSessions)
    .values({ userId, storylineId, startedFromEventId })
    .returning({
      id: storylineSessions.id,
      storylineId: storylineSessions.storylineId,
      lastActiveAt: storylineSessions.lastActiveAt,
      playheadOrder: storylineSessions.playheadOrder,
      startedFromEventId: storylineSessions.startedFromEventId,
    });
  return session;
}

/**
 * Writes a turn, the options offered on it, and the surfaces it plays out on.
 *
 * Three steps, because `story_turns.selected_choice_id` and `turn_choices.turn_id`
 * reference each other and there is no single atomic row for a turn with its
 * choices (invariants.md §5). They still commit together: a turn visible without
 * its options is a decision point the user cannot answer, and the partial unique
 * index would then block any attempt to open a replacement. A turn without the
 * surface it was written around would read as a reaction to nothing.
 *
 * `selectedChoiceId` starts null by construction — that is what "open" means,
 * and it is the column the index keys on.
 *
 * Returns only the id. Surfaces are stored with people as ids, and resolving
 * them is the reader's job, so the caller reads the turn back through it.
 */
export async function insertTurn(
  tx: Executor,
  sessionId: string,
  turnOrder: number,
  turn: NewTurn
): Promise<string> {
  const [written] = await tx
    .insert(storyTurns)
    .values({
      sessionId,
      turnOrder,
      narrativeContent: turn.narrativeContent,
      headline: turn.headline,
    })
    .returning({ id: storyTurns.id });

  // A closing beat can legitimately offer nothing, and drizzle rejects an empty
  // values(). The same goes for a text-only beat and its surfaces.
  if (turn.choices.length) {
    await tx.insert(turnChoices).values(
      turn.choices.map((choice, orderIndex) => ({
        turnId: written.id,
        label: choice.label,
        description: choice.description,
        orderIndex,
      }))
    );
  }
  if (turn.surfaces.length) {
    await tx.insert(turnSurfaces).values(
      turn.surfaces.map((surface, position) => ({
        turnId: written.id,
        position,
        type: surface.type,
        version: surface.version,
        payload: surface.payload,
      }))
    );
  }

  return written.id;
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

/**
 * Steps the playhead to the next beat above where it is.
 *
 * One statement rather than read-then-write, for the same reason
 * `answerTurnGuarded` is: two answers landing together would both read the same
 * value and the second would write a position the first had already passed. The
 * subquery is correlated against the row being updated, so the step is computed
 * from the value at write time.
 *
 * `COALESCE(..., playhead_order)` is what makes running out of story a no-op
 * rather than a failure. A playthrough that has passed the last beat simply
 * stays there, and the filter then shows it everything — which is correct, since
 * everything is what it has been through.
 */
export async function advancePlayhead(tx: Executor, sessionId: string): Promise<void> {
  await tx
    .update(storylineSessions)
    .set({
      playheadOrder: sql`COALESCE((
        SELECT MIN(${events.narrativeOrder}) FROM ${events}
         WHERE ${events.storylineId} = ${storylineSessions.storylineId}
           AND ${events.narrativeOrder} > ${storylineSessions.playheadOrder}
      ), ${storylineSessions.playheadOrder})`,
    })
    .where(eq(storylineSessions.id, sessionId));
}

/**
 * Raises the playhead to cover a beat the reader's own choice just caused.
 *
 * Without this the consequence of a decision is filed at a position the reader
 * has not reached, so the one beat they are guaranteed to care about is the one
 * beat they cannot see.
 *
 * The `<` guard makes it a raise rather than a set: retries and out-of-order
 * calls cannot walk the playhead backwards, which matters because
 * `generateConsequences` is safe to retry by design.
 */
export async function raisePlayheadTo(
  tx: Executor,
  sessionId: string,
  order: number
): Promise<void> {
  await tx
    .update(storylineSessions)
    .set({ playheadOrder: order })
    .where(and(eq(storylineSessions.id, sessionId), lt(storylineSessions.playheadOrder, order)));
}

/**
 * Claims a turn's consequences, in one guarded statement.
 *
 * Returns true to exactly one caller. Everyone else — a retry, a second tab, a
 * queue redelivery — gets false and must not write.
 *
 * The claim is a write rather than a read for the same reason `answerTurnGuarded`
 * is: checking first and writing second lets two callers both pass the check,
 * and the loser then appends a second set of beats for one decision. Affecting
 * zero rows is the only signal, and it means somebody else already has it.
 *
 * Deliberately stamped whatever the consequences came to, including nothing at
 * all — "computed and empty" is a real outcome and it has to leave a trace, or
 * it is indistinguishable from never having run.
 */
export async function claimConsequences(tx: Executor, turnId: string): Promise<boolean> {
  const [row] = await tx
    .update(storyTurns)
    // Abandonment is cleared, not kept alongside the stamp. It describes a
    // current state — "we are not going to work this one out" — and a turn that
    // has just been worked out is no longer in it. `consequence_attempts` keeps
    // the history of how hard it was.
    .set({ consequencesGeneratedAt: new Date(), consequencesAbandonedAt: null })
    .where(and(eq(storyTurns.id, turnId), isNull(storyTurns.consequencesGeneratedAt)))
    .returning({ id: storyTurns.id });

  return row !== undefined;
}

/**
 * Records that working out this turn's consequences is being attempted.
 *
 * Its own statement, on `db` rather than a caller's transaction, and deliberately
 * so: every transaction in `generateConsequences` is rolled back by the failure
 * this counter exists to count, which would leave the count at zero no matter how
 * many times it was tried. The write has to survive the failure to mean anything.
 *
 * Incremented in SQL rather than read-then-written, so two concurrent callers
 * cannot both read 2 and both write 3.
 */
export async function recordConsequenceAttempt(tx: Executor, turnId: string): Promise<void> {
  await tx
    .update(storyTurns)
    .set({ consequenceAttempts: sql`${storyTurns.consequenceAttempts} + 1` })
    .where(eq(storyTurns.id, turnId));
}

/**
 * Stops trying to work out this turn's consequences.
 *
 * The escape from the only unrecoverable state the loop had. The story continues
 * one beat poorer, which is a far better outcome than a session that can never
 * produce another turn — and the stamp says plainly that this happened, so the
 * gap is visible rather than inferred from an absence.
 *
 * Guarded on both stamps being null so it cannot overwrite a success that landed
 * concurrently, and so a second call is a no-op rather than a fresh timestamp.
 */
export async function abandonConsequences(tx: Executor, turnId: string): Promise<void> {
  await tx
    .update(storyTurns)
    .set({ consequencesAbandonedAt: new Date() })
    .where(
      and(
        eq(storyTurns.id, turnId),
        isNull(storyTurns.consequencesGeneratedAt),
        isNull(storyTurns.consequencesAbandonedAt)
      )
    );
}
