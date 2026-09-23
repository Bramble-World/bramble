import { pgTable, uuid, index, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { storylines } from './index';
import { relations } from 'drizzle-orm/_relations';

export const storylineLinkTypeEnum = pgEnum('storyline_link_type', [
  'sequel',
  'parallel', // same timeframe, different storyline
  'crossover',
  'spinoff',
]);

export const storylineLinks = pgTable(
  'storyline_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineAId: uuid('storyline_a_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    storylineBId: uuid('storyline_b_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    linkType: storylineLinkTypeEnum('link_type').notNull(),
    ...timestamps,
  },
  (table) => [
    index('idx_storyline_links_a').on(table.storylineAId),
    index('idx_storyline_links_b').on(table.storylineBId),
    uniqueIndex('idx_storyline_links_unique').on(
      table.storylineAId,
      table.storylineBId,
      table.linkType
    ),
  ]
);

export const storylineLinksRelations = relations(storylineLinks, ({ one }) => ({
  storylineA: one(storylines, {
    fields: [storylineLinks.storylineAId],
    references: [storylines.id],
    relationName: 'storylineA',
  }),
  storylineB: one(storylines, {
    fields: [storylineLinks.storylineBId],
    references: [storylines.id],
    relationName: 'storylineB',
  }),
}));
