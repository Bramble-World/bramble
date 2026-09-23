import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';

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
