import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '@/index';
import { duetCrossings, duets, storylineSessions, storyTurns, users } from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import type { Executor } from '../executor';

/**
 * Crossings (invariants.md §3): in a story for two, what one player does that
 * the other player's character would know about reaches the other side, as
 * texts from that character opening the other player's next beat.
 *
 * The consequence step says which beats would be known (`partnerKnows`, on
 * the duet version of its prompt only). Those are queued for the other side
 * here, and the other side's next turn is told to open with them
 * (`turnPrompt`'s `crossing`). The receiving side's turn prompt does the
 * re-voicing, rather than a model step of its own: the beat is being written
 * anyway, it already writes the partner's texts, and a separate call would
 * add cost and a second rewrite for nothing. Only the turn it writes is ever
 * shown; the source beat's words never are.
 *
 * Most choices stay on their own side. Never free text between players.
 */

/** At most this many waiting on a side: past it, the oldest is dropped. */
export const MAX_QUEUED_CROSSINGS = 3;

/** A side quiet this long gets nothing new: nothing piles up while they're away. */
export const QUIET_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export type Side = 'a' | 'b';

export type DuetSide = {
  duetId: string;
  side: Side;
  /** On this side, the character who is the other player. */
  partnerCharacterId: string | null;
  /** The other player, null once they've left. */
  otherUserId: string | null;
  /** The other side's storyline, null until they start it. */
  otherStorylineId: string | null;
};

/** Where a storyline sits in a story for two, or null for any other story. */
export async function duetSideOf(tx: Executor, storylineId: string): Promise<DuetSide | null> {
  const [row] = await tx
    .select()
    .from(duets)
    .where(or(eq(duets.sideAStorylineId, storylineId), eq(duets.sideBStorylineId, storylineId)))
    .limit(1);
  if (!row) return null;
  const side: Side = row.sideAStorylineId === storylineId ? 'a' : 'b';
  return {
    duetId: row.id,
    side,
    partnerCharacterId: side === 'a' ? row.sideAPartnerCharacterId : row.sideBPartnerCharacterId,
    otherUserId: side === 'a' ? row.sideBUserId : row.sideAUserId,
    otherStorylineId: side === 'a' ? row.sideBStorylineId : row.sideAStorylineId,
  };
}

export type ReceiverFacts = {
  /** The other player still has an account. */
  present: boolean;
  /** Their side has ended. */
  ended: boolean;
  /** Their side has started (they've begun it as a story). */
  started: boolean;
  /** When they last chose something on their side, if ever. */
  lastChoiceAt: Date | null;
  /** When they started it, for a side started with no choice yet. */
  startedAt: Date | null;
};

export type CrossingVerdict = 'queue' | 'hold' | 'gone' | 'ended' | 'quiet';

/**
 * Whether something crossing now reaches the other side. Pure.
 *
 * A side not yet started holds it, and opens with the newest when it does.
 * A side quiet for `QUIET_AFTER_MS` gets nothing new: the active player's
 * story goes on with the quiet player's character played by the model, as
 * any character is, and crossings resume once they choose again.
 */
export function crossingVerdict(facts: ReceiverFacts, now: Date): CrossingVerdict {
  if (!facts.present) return 'gone';
  if (!facts.started) return 'hold';
  if (facts.ended) return 'ended';
  const active = facts.lastChoiceAt ?? facts.startedAt;
  if (active && now.getTime() - active.getTime() > QUIET_AFTER_MS) return 'quiet';
  return 'queue';
}

async function receiverFacts(tx: Executor, side: DuetSide): Promise<ReceiverFacts> {
  if (!side.otherUserId) {
    return { present: false, ended: false, started: false, lastChoiceAt: null, startedAt: null };
  }
  const [present] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, side.otherUserId))
    .limit(1);
  if (!present) {
    return { present: false, ended: false, started: false, lastChoiceAt: null, startedAt: null };
  }
  if (!side.otherStorylineId) {
    return { present: true, ended: false, started: false, lastChoiceAt: null, startedAt: null };
  }
  const [session] = await tx
    .select({
      id: storylineSessions.id,
      endedAt: storylineSessions.endedAt,
      startedAt: storylineSessions.createdAt,
    })
    .from(storylineSessions)
    .where(eq(storylineSessions.storylineId, side.otherStorylineId))
    .orderBy(desc(storylineSessions.createdAt))
    .limit(1);
  if (!session) {
    return { present: true, ended: false, started: false, lastChoiceAt: null, startedAt: null };
  }
  const [last] = await tx
    .select({ at: storyTurns.updatedAt })
    .from(storyTurns)
    .where(and(eq(storyTurns.sessionId, session.id), isNotNull(storyTurns.selectedChoiceId)))
    .orderBy(desc(storyTurns.updatedAt))
    .limit(1);
  return {
    present: true,
    ended: session.endedAt !== null,
    started: true,
    lastChoiceAt: last?.at ?? null,
    startedAt: session.startedAt,
  };
}

/**
 * Queues what crossed from `side` for the other side, and keeps at most
 * `MAX_QUEUED_CROSSINGS` waiting there (the oldest dropped). Inside the
 * transaction that records the beats it came from.
 */
export async function queueCrossings(
  tx: Executor,
  side: DuetSide,
  beats: ReadonlyArray<{ title: string; description: string }>,
  now = new Date()
): Promise<CrossingVerdict> {
  if (beats.length === 0) return 'queue';
  const facts = await receiverFacts(tx, side);
  const verdict = crossingVerdict(facts, now);
  if (verdict !== 'queue' && verdict !== 'hold') return verdict;

  const toUserId = side.otherUserId!;
  await tx.insert(duetCrossings).values(
    beats.map((beat) => ({
      duetId: side.duetId,
      toUserId,
      fromSide: side.side,
      toStorylineId: verdict === 'queue' ? side.otherStorylineId : null,
      title: beat.title,
      description: beat.description,
    }))
  );
  await capQueued(tx, side.duetId, toUserId);
  await track(toUserId, {
    name: 'duet_crossed',
    properties: { from_side: side.side, held: verdict === 'hold', count: beats.length },
  });
  return verdict;
}

/** Past the cap, the oldest waiting on that side are dropped. */
async function capQueued(tx: Executor, duetId: string, toUserId: string): Promise<void> {
  const waiting = await tx
    .select({ id: duetCrossings.id })
    .from(duetCrossings)
    .where(
      and(
        eq(duetCrossings.duetId, duetId),
        eq(duetCrossings.toUserId, toUserId),
        eq(duetCrossings.status, 'queued')
      )
    )
    .orderBy(desc(duetCrossings.createdAt), desc(duetCrossings.id));
  const over = waiting.slice(MAX_QUEUED_CROSSINGS).map((row) => row.id);
  if (over.length) {
    await tx
      .update(duetCrossings)
      .set({ status: 'dropped' })
      .where(inArray(duetCrossings.id, over));
  }
}

export type PendingCrossing = { id: string; title: string; description: string };

/** The oldest crossing waiting on this storyline: one per beat. */
export async function nextCrossing(storylineId: string): Promise<PendingCrossing | null> {
  const [row] = await db
    .select({
      id: duetCrossings.id,
      title: duetCrossings.title,
      description: duetCrossings.description,
    })
    .from(duetCrossings)
    .where(and(eq(duetCrossings.toStorylineId, storylineId), eq(duetCrossings.status, 'queued')))
    .orderBy(asc(duetCrossings.createdAt), asc(duetCrossings.id))
    .limit(1);
  return row ?? null;
}

/** It reached the other side, in this beat. */
export async function markDelivered(userId: string, crossingId: string, turnId: string) {
  const updated = await db
    .update(duetCrossings)
    .set({ status: 'delivered', deliveredTurnId: turnId })
    .where(and(eq(duetCrossings.id, crossingId), eq(duetCrossings.status, 'queued')))
    .returning({ id: duetCrossings.id });
  if (updated.length) await track(userId, { name: 'duet_crossing_delivered', properties: {} });
}

/** A side has ended: nothing more reaches it. */
export async function dropCrossingsTo(storylineId: string): Promise<void> {
  await db
    .update(duetCrossings)
    .set({ status: 'dropped' })
    .where(and(eq(duetCrossings.toStorylineId, storylineId), eq(duetCrossings.status, 'queued')));
}

/**
 * A player started their side: what was held for it now waits on it, the
 * newest only, so its first beat opens with that; the rest are dropped.
 */
export async function attachHeldCrossings(
  tx: Executor,
  duetId: string,
  toUserId: string,
  storylineId: string
): Promise<void> {
  const held = await tx
    .select({ id: duetCrossings.id })
    .from(duetCrossings)
    .where(
      and(
        eq(duetCrossings.duetId, duetId),
        eq(duetCrossings.toUserId, toUserId),
        eq(duetCrossings.status, 'queued'),
        isNull(duetCrossings.toStorylineId)
      )
    )
    .orderBy(desc(duetCrossings.createdAt), desc(duetCrossings.id));
  if (!held.length) return;
  const [newest, ...rest] = held;
  await tx
    .update(duetCrossings)
    .set({ toStorylineId: storylineId })
    .where(eq(duetCrossings.id, newest.id));
  if (rest.length) {
    await tx
      .update(duetCrossings)
      .set({ status: 'dropped' })
      .where(
        inArray(
          duetCrossings.id,
          rest.map((row) => row.id)
        )
      );
  }
}

/**
 * Whether a crossing is waiting for this player on a side they've started,
 * newer than `since`: the push sweep's "your story moved" (`duet_moved`).
 */
export async function crossingWaitingFor(
  tx: Executor,
  userId: string,
  since: Date
): Promise<boolean> {
  const rows = await tx
    .select({ at: duetCrossings.createdAt })
    .from(duetCrossings)
    .where(
      and(
        eq(duetCrossings.toUserId, userId),
        eq(duetCrossings.status, 'queued'),
        isNotNull(duetCrossings.toStorylineId)
      )
    )
    .orderBy(desc(duetCrossings.createdAt))
    .limit(1);
  return rows.length > 0 && rows[0].at.getTime() > since.getTime();
}

/** A player is leaving: everything that came from their side goes too. */
export async function forgetCrossingsFrom(tx: Executor, duetId: string, side: Side): Promise<void> {
  await tx
    .delete(duetCrossings)
    .where(and(eq(duetCrossings.duetId, duetId), eq(duetCrossings.fromSide, side)));
}
