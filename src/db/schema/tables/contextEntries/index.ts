import { pgTable, uuid, index, text, pgEnum } from 'drizzle-orm/pg-core';
import { storylines } from '../storylines';
import { characters } from '../characters';
import { storyTurns } from '../storylineSessions/storyTurns';
import { timestamps } from '../../../util/timestamps';
import { relations } from 'drizzle-orm/_relations';

export const contextSourceEnum = pgEnum('context_source', [
  'inferred', // extracted/inferred by the pipeline during initial extraction
  'conversation_generated', // inferred by the pipeline during a later conversation session
  'user_provided', // explicitly supplied by the user
]);

export const contextEntries = pgTable(
  'context_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id').references(() => characters.id, {
      onDelete: 'cascade',
    }), // nullable — storyline-level if not set

    content: text().notNull(),
    source: contextSourceEnum().notNull().default('inferred'),

    // Set when source is 'conversation_generated' — the turn whose choice
    // caused this backstory to be inferred, mirroring events.triggeredByTurnId.
    triggeredByTurnId: uuid('triggered_by_turn_id').references(() => storyTurns.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (table) => [
    index('idx_context_entries_storyline').on(table.storylineId),
    index('idx_context_entries_character').on(table.characterId),
    index('idx_context_entries_triggered_by').on(table.triggeredByTurnId),
  ]
);

export const contextEntriesRelations = relations(contextEntries, ({ one }) => ({
  storyline: one(storylines, {
    fields: [contextEntries.storylineId],
    references: [storylines.id],
  }),
  character: one(characters, {
    fields: [contextEntries.characterId],
    references: [characters.id],
  }),
  triggeredByTurn: one(storyTurns, {
    fields: [contextEntries.triggeredByTurnId],
    references: [storyTurns.id],
  }),
}));
