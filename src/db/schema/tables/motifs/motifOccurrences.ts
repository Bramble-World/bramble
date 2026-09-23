import { index, pgTable, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { events } from '../events';
import { storylines } from '../storylines';
import { motifs } from './index';

export const motifOccurrences = pgTable(
  'motif_occurrences',
  {
    id: uuid().primaryKey().defaultRandom(),
    motifId: uuid('motif_id')
      .notNull()
      .references(() => motifs.id, { onDelete: 'cascade' }),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => events.id, {
      onDelete: 'set null',
    }), // nullable — a motif can color a whole storyline without one exact beat

    ...timestamps,
  },
  (table) => [
    index('idx_motif_occurrences_motif').on(table.motifId),
    index('idx_motif_occurrences_storyline').on(table.storylineId),
  ]
);
