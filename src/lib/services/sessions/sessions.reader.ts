import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import { db } from '@/index';
import { storylines, storylineSessions, storyTurns, turnChoices } from '@/db/schema/tables';
import { Executor } from '../executor';
import { PublicSession, TurnWithChoices } from './sessions.types';

const sessionColumns = {
  id: storylineSessions.id,
  storylineId: storylineSessions.storylineId,
  lastActiveAt: storylineSessions.lastActiveAt,
  playheadOrder: storylineSessions.playheadOrder,
};

export async function getSession(userId: string, sessionId: string): Promise<PublicSession | null> {
  return getSessionIn(db, userId, sessionId);
}

/**
 * `getSession` against a caller's transaction.
 *
 * Exists because `startSession` has to read the session back after stepping its
 * playhead, and reading it on `db` would land outside that transaction and
 * return the pre-step value.
 */
export async function getSessionIn(
  tx: Executor,
  userId: string,
  sessionId: string
): Promise<PublicSession | null> {
  const [session] = await tx
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

/**
 * `getTurn`, but only if the turn is in one of this reader's sessions.
 *
 * `storyTurns` has no owner column — ownership runs through
 * `storylineSessions.userId` — so an unscoped `getTurn` with an id from a URL
 * would serve another reader's story. Exists for the self-reconciling answer
 * path, which has to read back a turn it was just refused.
 */
export async function getTurnForUser(
  tx: Executor,
  userId: string,
  turnId: string
): Promise<TurnWithChoices | null> {
  const [owned] = await tx
    .select({ id: storyTurns.id })
    .from(storyTurns)
    .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
    .where(and(eq(storyTurns.id, turnId), eq(storylineSessions.userId, userId)))
    .limit(1);

  return owned ? getTurn(tx, turnId) : null;
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

/**
 * Idle sessions with their owner, for the arc sweep.
 *
 * Separate from `findIdleSessions` because `PublicSession` deliberately omits
 * `userId` — it is an ownership key, not something a caller in a request should
 * be handed. The sweep is not a request: it runs for everyone, and it needs the
 * owner precisely so the summarise call it makes is still ownership-scoped
 * rather than bypassing the check.
 */
export async function findIdleSessionOwners(
  idleSince: Date
): Promise<Array<{ storylineId: string; userId: string }>> {
  return db
    .selectDistinct({
      storylineId: storylineSessions.storylineId,
      userId: storylineSessions.userId,
    })
    .from(storylineSessions)
    .where(lt(storylineSessions.lastActiveAt, idleSince));
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

/**
 * Whether this turn's consequences have already been worked out.
 *
 * Reads the stamp rather than looking for a beat that points at the turn. Those
 * are not the same question: the consequence prompt may legitimately decide a
 * choice changed nothing, and that outcome writes no beat — so "no beat" used
 * to mean both "never ran" and "ran, and nothing happened". Every turn in the
 * second state re-generated on each retry, and could produce a beat the second
 * time that the first had not.
 */
export async function turnHasResolvedConsequences(tx: Executor, turnId: string): Promise<boolean> {
  const [row] = await tx
    .select({ at: storyTurns.consequencesGeneratedAt })
    .from(storyTurns)
    .where(eq(storyTurns.id, turnId))
    .limit(1);

  return row?.at != null;
}

/**
 * Turns in this session that were answered and never resolved.
 *
 * The state a client lands in when it dies between answering and having the
 * consequences written — and the reason `POST /sessions/:id/turn` can be defined
 * as "bring this session to a playable state" rather than as three ordered calls
 * the client has to get right.
 *
 * Ascending, because consequences must be written in the order they were caused:
 * each one's beats become canon the next turn's prompt reads.
 *
 * `idx_story_turns_owed_consequences` is exactly this predicate and has had no
 * caller since it was added.
 */
export async function findTurnsOwedConsequences(
  tx: Executor,
  sessionId: string
): Promise<Array<{ id: string; turnOrder: number }>> {
  return tx
    .select({ id: storyTurns.id, turnOrder: storyTurns.turnOrder })
    .from(storyTurns)
    .where(
      and(
        eq(storyTurns.sessionId, sessionId),
        isNotNull(storyTurns.selectedChoiceId),
        isNull(storyTurns.consequencesGeneratedAt),
        // Turns we gave up on are not owed. Without this the settle-then-
        // generate loop retries an unproducible turn on every request and the
        // session can never reach `generateTurn` again.
        isNull(storyTurns.consequencesAbandonedAt)
      )
    )
    .orderBy(asc(storyTurns.turnOrder));
}

/**
 * How many times this turn's consequences have been attempted.
 *
 * Read after a failure to decide whether there is budget left. A missing turn
 * reports 0 rather than throwing: the caller is already handling an error, and
 * a second one raised while deciding what to do about the first buries it.
 */
export async function consequenceAttempts(tx: Executor, turnId: string): Promise<number> {
  const [row] = await tx
    .select({ attempts: storyTurns.consequenceAttempts })
    .from(storyTurns)
    .where(eq(storyTurns.id, turnId))
    .limit(1);

  return row?.attempts ?? 0;
}

/** How many turns the reader has answered — the only honest progress signal. */
export async function countAnsweredTurns(tx: Executor, sessionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(storyTurns)
    .where(and(eq(storyTurns.sessionId, sessionId), isNotNull(storyTurns.selectedChoiceId)));

  return row?.n ?? 0;
}

/**
 * When each of these storylines was last played by this reader.
 *
 * Ordering the arc list by recency is the one thing that stops it looking
 * arbitrary, and `lastActiveAt` is the only column that records it —
 * `storylines.createdAt` is when the conversation was imported, which is the
 * same instant for every arc in a single import.
 *
 * Storylines never played are simply absent from the map; the caller decides
 * what a null means rather than being handed an epoch to guess at.
 */
export async function lastPlayedByStoryline(
  userId: string,
  storylineIds: string[]
): Promise<Map<string, Date>> {
  if (storylineIds.length === 0) return new Map();

  const rows = await db
    .select({
      storylineId: storylineSessions.storylineId,
      lastPlayedAt: max(storylineSessions.lastActiveAt),
    })
    .from(storylineSessions)
    .where(
      and(
        eq(storylineSessions.userId, userId),
        inArray(storylineSessions.storylineId, storylineIds)
      )
    )
    .groupBy(storylineSessions.storylineId);

  return new Map(
    rows.flatMap((row) => (row.lastPlayedAt ? [[row.storylineId, row.lastPlayedAt] as const] : []))
  );
}

/**
 * The reader's most recent playthrough of one storyline opened at one beat.
 *
 * The resume key is `startedFromEventId`, not the playhead. The playhead moves as
 * they play, so a session opened at beat 5 and played to beat 9 is
 * indistinguishable from one opened at 9 — the question "is this the playthrough
 * they started from the moment they just tapped" can only be answered by what it
 * was opened at.
 *
 * Most recent by `lastActiveAt`, matching the index, because `mode: 'new'` lets a
 * reader deliberately keep several playthroughs of the same beat and the one they
 * mean is the one they last touched.
 */
export async function latestSessionFromEvent(
  tx: Executor,
  userId: string,
  storylineId: string,
  eventId: string
): Promise<PublicSession | null> {
  const [session] = await tx
    .select(sessionColumns)
    .from(storylineSessions)
    .where(
      and(
        eq(storylineSessions.userId, userId),
        eq(storylineSessions.storylineId, storylineId),
        eq(storylineSessions.startedFromEventId, eventId)
      )
    )
    .orderBy(desc(storylineSessions.lastActiveAt))
    .limit(1);

  return session ?? null;
}

/**
 * Serialises session creation for one storyline, for the caller's transaction.
 *
 * Find-or-create is a race without it: two taps on the same moment both find
 * nothing, both insert, and the reader has two playthroughs of one beat with
 * their progress split between them. A unique index cannot express this, because
 * `mode: 'new'` must still be able to create a second one deliberately.
 *
 * Locks the storyline row, which is the same row `lockStorylineForOrdering`
 * takes. Contending with timeline writes is correct rather than unfortunate —
 * both are deciding where a reader sits in a story.
 */
export async function lockStorylineForSessions(tx: Executor, storylineId: string): Promise<void> {
  await tx
    .select({ id: storylines.id })
    .from(storylines)
    .where(eq(storylines.id, storylineId))
    .for('update');
}

/**
 * The reader's latest playthrough of each of these beats, with its progress.
 *
 * One query for a whole page of ranked moments. The world screen draws twenty of
 * them and each needs to know whether it has been played, so a query per event is
 * twenty round trips on the client's cold-start path.
 *
 * `distinct on` picks the newest row per beat inside the database rather than
 * fetching every session and folding them in JS, which matters for a reader who
 * has replayed a moment several times.
 */
export async function playthroughsForEvents(
  userId: string,
  eventIds: string[]
): Promise<Map<string, { sessionId: string; turnsAnswered: number; lastActiveAt: Date }>> {
  if (eventIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([storylineSessions.startedFromEventId], {
      eventId: storylineSessions.startedFromEventId,
      sessionId: storylineSessions.id,
      lastActiveAt: storylineSessions.lastActiveAt,
      /*
       * Correlated rather than a join and a group by: the outer query is already
       * picking one row per beat, and grouping would fight that.
       *
       * Written with literal identifiers rather than the column helpers, and it
       * has to be. Drizzle renders `storylineSessions.id` as bare `"id"` — the
       * table prefix is dropped for the query's own table — which is correct at
       * the top level and silently wrong here: inside the subquery `"id"` binds
       * to `story_turns.id`, so the correlation compares a turn's session to the
       * turn's own id and matches nothing. The count came back 0 for a session
       * that had demonstrably answered a turn. No interpolation, so nothing here
       * is user input; a column rename is caught by the tests.
       */
      turnsAnswered: sql<number>`(
        select count(*)::int from story_turns t
        where t.session_id = storyline_sessions.id
          and t.selected_choice_id is not null
      )`,
    })
    .from(storylineSessions)
    .where(
      and(
        eq(storylineSessions.userId, userId),
        inArray(storylineSessions.startedFromEventId, eventIds)
      )
    )
    .orderBy(storylineSessions.startedFromEventId, desc(storylineSessions.lastActiveAt));

  return new Map(
    rows.flatMap((row) =>
      row.eventId
        ? [
            [
              row.eventId,
              {
                sessionId: row.sessionId,
                turnsAnswered: row.turnsAnswered,
                lastActiveAt: row.lastActiveAt,
              },
            ] as const,
          ]
        : []
    )
  );
}

/**
 * Every turn in this session the reader has already answered, oldest first.
 *
 * The open turn is excluded by the predicate rather than by a filter afterwards:
 * an unanswered turn has no `selectedChoiceId`, so "answered" and "not the one
 * awaiting a decision" are the same condition, and expressing it once means the
 * two cannot drift apart.
 */
export async function listAnsweredTurns(
  tx: Executor,
  sessionId: string
): Promise<TurnWithChoices[]> {
  return tx.query.storyTurns.findMany({
    where: { sessionId, selectedChoiceId: { isNotNull: true } },
    with: { choices: { orderBy: { orderIndex: 'asc' } } },
    orderBy: { turnOrder: 'asc' },
  });
}
