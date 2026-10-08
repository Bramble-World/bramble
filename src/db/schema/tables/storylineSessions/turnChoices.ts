import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { storyTurns } from './storyTurns';
import { timestamps } from '../../../util/timestamps';

export const turnChoices = pgTable(
  'turn_choices',
  {
    id: uuid().primaryKey().defaultRandom(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => storyTurns.id, { onDelete: 'cascade' }),

    label: text().notNull(),
    description: text(),
    orderIndex: integer('order_index').notNull(),

    ...timestamps,
  },
  (table) => [index('idx_turn_choices_turn').on(table.turnId)]
);
