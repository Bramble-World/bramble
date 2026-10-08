import { and, asc, eq, gt, inArray, lte, max, min, sql } from 'drizzle-orm';
import { db } from '@/index';
import { characterRelationships, characters, eventParticipants, events } from '@/db/schema/tables';
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
  engagementScore: events.engagementScore,
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

/**
 * Characters who appear in beats at or below a given narrative order.
 *
 * The database-row form of the rule `metCharacterIds` expresses over prompt
 * context. A client-facing read cannot use `listTimeline`, because `PublicEvent`
 * carries no participants — and guessing, or returning the whole cast, puts
 * people on screen the story has not introduced. One of them was described by
 * extraction as "the investor who offers $300,000", so that is a plot on a
 * screen the reader opens first.
 */
export async function charactersMetUpTo(
  storylineId: string,
  reachedOrder: number
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ characterId: eventParticipants.characterId })
    .from(eventParticipants)
    .innerJoin(events, eq(events.id, eventParticipants.eventId))
    .where(and(eq(events.storylineId, storylineId), lte(events.narrativeOrder, reachedOrder)));

  return new Set(rows.map((r) => r.characterId));
}

/**
 * Where a beat sits in its storyline, if it is in that storyline at all.
 *
 * Both halves matter. The order is what a session's playhead is set to; the
 * storyline predicate is what stops an event id from one story positioning a
 * session in another. `events` carries no owner column — ownership runs through
 * its storyline — so pairing the two ids here is the whole of the check, and a
 * caller that already proved the storyline is the reader's has thereby proved
 * the event is too.
 *
 * Null means "no such beat in this storyline", which the caller turns into a 404
 * rather than distinguishing from "no such beat anywhere". Telling those apart
 * would confirm that someone else's event exists.
 */
export async function narrativeOrderOf(
  storylineId: string,
  eventId: string
): Promise<number | null> {
  const [row] = await db
    .select({ narrativeOrder: events.narrativeOrder })
    .from(events)
    .where(and(eq(events.storylineId, storylineId), eq(events.id, eventId)))
    .limit(1);

  return row?.narrativeOrder ?? null;
}
