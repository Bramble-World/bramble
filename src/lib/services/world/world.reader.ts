import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/index';
import { events, storylines } from '@/db/schema/tables';
import { WorldEvent } from './world.types';

/**
 * The read behind the moments a reader is offered.
 *
 * Anchored on `storylines.userId`, which is what makes the service safe without a
 * per-id ownership check: no identifier in these results ever arrived in a
 * request, so there is nothing to confuse with another tenant's. `events` carries
 * no owner column of its own — ownership runs through its storyline — so the join
 * predicate is not a filter, it is the whole of the tenancy guarantee.
 */

/**
 * The reader's highest-scoring beats, across every storyline they own.
 *
 * Two predicates, both load-bearing:
 *
 * - `origin = 'extracted'` — only beats from the imported conversation are entry
 *   points. Starting "from" a beat the reader's own choice caused is incoherent,
 *   and generated beats are most of what makes the list hundreds long. Same
 *   predicate `scriptExhausted` uses, so the two agree about what is script.
 * - `engagement_score IS NOT NULL` — an unscored beat is excluded rather than
 *   ranked last. Null means nobody ever asked the model, which is not the same
 *   claim as "the model judged this dull"; ordering nulls last would assert the
 *   second while only knowing the first.
 *
 * The tiebreak is deterministic to the row id, so the twenty a reader sees do not
 * reshuffle between launches when scores tie — which they will, since the scale
 * is ten wide and the candidates are many.
 */
export async function topEventsFor(userId: string, limit: number): Promise<WorldEvent[]> {
  return db
    .select({
      eventId: events.id,
      storylineId: events.storylineId,
      storylineTitle: storylines.title,
      title: events.title,
      occurredAt: events.occurredAt,
      // Not-null by the predicate below, which the column type cannot express.
      score: sql<number>`${events.engagementScore}`,
    })
    .from(events)
    .innerJoin(storylines, eq(storylines.id, events.storylineId))
    .where(
      and(
        eq(storylines.userId, userId),
        eq(events.origin, 'extracted'),
        isNotNull(events.engagementScore)
      )
    )
    .orderBy(desc(events.engagementScore), desc(events.occurredAt), asc(events.id))
    .limit(limit);
}

/**
 * Whether more scored beats exist than were returned.
 *
 * A second query rather than fetching `limit + 1` and dropping one: the extra row
 * would have to be carried through the service and the view only to be discarded,
 * and this count is covered by the same partial index the ranked read uses.
 */
export async function countRankableFor(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .innerJoin(storylines, eq(storylines.id, events.storylineId))
    .where(
      and(
        eq(storylines.userId, userId),
        eq(events.origin, 'extracted'),
        isNotNull(events.engagementScore)
      )
    );

  return row?.n ?? 0;
}
