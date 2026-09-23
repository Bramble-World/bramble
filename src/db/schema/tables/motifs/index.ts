import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { relations } from 'drizzle-orm/_relations';
import { motifParticipants } from './motifParticipants';
import { motifOccurrences } from './motifOccurrences';

export const motifs = pgTable(
  'motifs',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    label: text().notNull(), // short name, e.g. "the lasagna incident"
    description: text(),

    ...timestamps,
  },
  (table) => [index('idx_motifs_user').on(table.userId)]
);

export const motifsRelations = relations(motifs, ({ one, many }) => ({
  user: one(users, {
    fields: [motifs.userId],
    references: [users.id],
  }),
  participants: many(motifParticipants),
  occurrences: many(motifOccurrences),
}));
