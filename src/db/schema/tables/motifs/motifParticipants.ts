import { index, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import { persons } from '../persons';
import { motifs } from './index';
import { relations } from 'drizzle-orm/_relations';

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

export const motifParticipantsRelations = relations(motifParticipants, ({ one }) => ({
  motif: one(motifs, {
    fields: [motifParticipants.motifId],
    references: [motifs.id],
  }),
  person: one(persons, {
    fields: [motifParticipants.personId],
    references: [persons.id],
  }),
}));
