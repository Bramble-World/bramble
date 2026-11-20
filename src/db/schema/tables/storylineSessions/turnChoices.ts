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
    /**
     * The exact words the reader sends if they pick this: a text to someone in
     * the scene. Null when the choice is an action rather than a text (a call,
     * putting the phone down), and on every choice written before replies.
     */
    reply: text(),
    orderIndex: integer('order_index').notNull(),

    ...timestamps,
  },
  (table) => [index('idx_turn_choices_turn').on(table.turnId)]
);
