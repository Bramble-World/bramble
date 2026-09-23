import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/index';
import { events, motifs } from '@/db/schema/tables';
import { PublicMotif } from './motifs.types';

const columns = { id: motifs.id, label: motifs.label, description: motifs.description };

export async function listMotifs(userId: string): Promise<PublicMotif[]> {
  return db
    .select(columns)
    .from(motifs)
    .where(eq(motifs.userId, userId))
    .orderBy(asc(motifs.createdAt));
}

export async function getMotif(userId: string, motifId: string): Promise<PublicMotif | null> {
  const [motif] = await db
    .select(columns)
    .from(motifs)
    .where(and(eq(motifs.userId, userId), eq(motifs.id, motifId)))
    .limit(1);
  return motif ?? null;
}

/**
 * Whether an event belongs to a storyline.
 *
 * Reaches into `events`, which otherwise belongs to the timeline service, because
 * the rule being checked is `motifOccurrences.eventId` must belong to its
 * `storylineId` (invariants.md §3) — and the write it guards lives here. A
 * callback pointing at the wrong story's beat is accepted by every foreign key
 * involved.
 */
export async function eventBelongsToStoryline(
  storylineId: string,
  eventId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.storylineId, storylineId), eq(events.id, eventId)))
    .limit(1);
  return row !== undefined;
}
