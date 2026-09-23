import { and, asc, eq, gt, inArray, max, min, sql } from 'drizzle-orm';
import { db } from '@/index';
import { characterRelationships, characters, events } from '@/db/schema/tables';
import { Executor } from '../executor';
import { PublicEvent } from './timeline.types';

const columns = {
  id: events.id,
  storylineId: events.storylineId,
  narrativeOrder: events.narrativeOrder,
  occurredAt: events.occurredAt,
  title: events.title,
  description: events.description,
  stakes: events.stakes,
  origin: events.origin,
  triggeredByTurnId: events.triggeredByTurnId,
  generationRationale: events.generationRationale,
};

/** The canonical timeline, in the order beats are presented. */
export async function listTimeline(storylineId: string): Promise<PublicEvent[]> {
  return db
    .select(columns)
    .from(events)
    .where(eq(events.storylineId, storylineId))
    .orderBy(asc(events.narrativeOrder));
}

/**
 * Takes a row lock on the storyline for the duration of the transaction.
 *
 * Allocating a narrative order means reading the timeline and choosing a value,
 * which is a read-then-write race: two concurrent consequence writes both read
 * the same maximum and both choose the same next slot. Since PR #23 that
 * collision is a unique-index violation rather than silent corruption, but a
 * loud failure on a user's click is still a failure. Serialising per storyline
 * turns it into a brief wait instead.
 *
 * The storyline row is the lock because it is the parent every beat shares, and
 * locking it blocks nothing else anyone is likely to be doing.
 */
export async function lockStorylineForOrdering(tx: Executor, storylineId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM storylines WHERE id = ${storylineId} FOR UPDATE`);
}

/** Gap-numbered: the next beat appended to the end of the timeline. */
export async function nextNarrativeOrder(tx: Executor, storylineId: string): Promise<number> {
  const [row] = await tx
    .select({ highest: max(events.narrativeOrder) })
    .from(events)
    .where(eq(events.storylineId, storylineId));

  return (row?.highest ?? 0) + NARRATIVE_ORDER_GAP;
}

/** Convention, not a constraint: see invariants.md §6. */
export const NARRATIVE_ORDER_GAP = 1000;

/**
 * A slot between `afterOrder` and whatever comes next.
 *
 * Returns the midpoint, or a full gap past the end when nothing follows. Null
 * means the space is exhausted — adjacent integers with nothing between them —
 * which the caller must surface rather than round into a collision. Gaps of 1000
 * make that vanishingly unlikely, but "unlikely" is not "impossible" and the
 * failure would otherwise be a unique-violation from a value silently reused.
 */
export async function gapOrderAfter(
  tx: Executor,
  storylineId: string,
  afterOrder: number
): Promise<number | null> {
  const [row] = await tx
    .select({ next: min(events.narrativeOrder) })
    .from(events)
    .where(and(eq(events.storylineId, storylineId), gt(events.narrativeOrder, afterOrder)));

  if (row?.next == null) return afterOrder + NARRATIVE_ORDER_GAP;

  const midpoint = Math.floor((afterOrder + row.next) / 2);
  return midpoint > afterOrder && midpoint < row.next ? midpoint : null;
}

/** Which of these character ids belong to the storyline. Guards eventParticipants. */
export async function charactersInStoryline(
  tx: Executor,
  storylineId: string,
  characterIds: string[]
): Promise<Set<string>> {
  if (characterIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.storylineId, storylineId), inArray(characters.id, characterIds)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The storyline an event and a relationship each belong to.
 *
 * `relationshipStates` names both and no foreign key relates them, so "a state
 * change attributed to an unrelated story's event" (invariants.md §3) is
 * writable. Returned as a pair so the caller compares them rather than trusting
 * either.
 */
export async function storylinesOf(
  tx: Executor,
  relationshipId: string,
  eventId: string
): Promise<{ relationship: string | null; event: string | null }> {
  const [rel] = await tx
    .select({ storylineId: characterRelationships.storylineId })
    .from(characterRelationships)
    .where(eq(characterRelationships.id, relationshipId))
    .limit(1);

  const [evt] = await tx
    .select({ storylineId: events.storylineId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  return { relationship: rel?.storylineId ?? null, event: evt?.storylineId ?? null };
}
