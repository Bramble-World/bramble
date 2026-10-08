import { db } from '@/index';
import { motifOccurrences, motifParticipants, motifs } from '@/db/schema/tables';
import { NewMotif, PublicMotif } from './motifs.types';

/**
 * Creates a motif and attaches its participants in one transaction.
 *
 * A motif with no participants is not wrong, but a motif whose participants
 * half-wrote is: the running joke would belong to the wrong subset of people,
 * and nothing would report it. The two writes are one fact, so they commit
 * together.
 */
export async function insertMotif(
  userId: string,
  input: NewMotif,
  personIds: string[]
): Promise<PublicMotif> {
  return db.transaction(async (tx) => {
    const [motif] = await tx
      .insert(motifs)
      .values({ userId, ...input })
      .returning({ id: motifs.id, label: motifs.label, description: motifs.description });

    if (personIds.length > 0) {
      await tx
        .insert(motifParticipants)
        .values(personIds.map((personId) => ({ motifId: motif.id, personId })))
        .onConflictDoNothing();
    }

    return motif;
  });
}

export async function insertMotifOccurrenceIfAbsent(input: {
  motifId: string;
  storylineId: string;
  eventId?: string;
}): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(motifOccurrences)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: motifOccurrences.id });
  return row ?? null;
}
