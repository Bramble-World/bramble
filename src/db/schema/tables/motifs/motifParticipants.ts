import { index, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import { persons } from '../persons';
import { motifs } from './index';

export const motifParticipants = pgTable(
  'motif_participants',
  {
    motifId: uuid('motif_id')
      .notNull()
      .references(() => motifs.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.motifId, table.personId] }),
    index('idx_motif_participants_person').on(table.personId),
  ]
);
