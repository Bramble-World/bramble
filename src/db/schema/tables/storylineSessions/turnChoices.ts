import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { storyTurns } from './storyTurns';
import { timestamps } from '../../../util/timestamps';
import { relations } from 'drizzle-orm/_relations';

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

export const turnChoicesRelations = relations(turnChoices, ({ one }) => ({
  turn: one(storyTurns, {
    fields: [turnChoices.turnId],
    references: [storyTurns.id],
    relationName: 'turnChoicesForTurn',
  }),
}));
