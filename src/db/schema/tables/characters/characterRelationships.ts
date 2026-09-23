import { pgTable, uuid, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { storylines } from '../storylines';
import { characters } from './index';
import { relations } from 'drizzle-orm/_relations';
import { relationshipStates } from '../relationshipStates';
import { sql } from 'drizzle-orm/sql/sql';

export const characterRelationships = pgTable(
  'character_relationships',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),

    characterAId: uuid('character_a_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    characterBId: uuid('character_b_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),

    // Baseline dynamic — how things stand at the start of the story.
    // The relationship *type* (siblings, coworkers, etc.) lives on
    // person_relationships instead, since that's a persistent fact about
    // the real people, not something that should vary per storyline.
    baselineDynamic: jsonb('baseline_dynamic').$type<{
      closeness?: string;
      tension?: string;
      powerBalance?: string;
    }>(),

    ...timestamps,
  },
  (table) => [
    index('idx_character_relationships_storyline').on(table.storylineId),
    index('idx_character_relationships_a').on(table.characterAId),
    index('idx_character_relationships_b').on(table.characterBId),
    // Same canonical-ordering guarantee as person_relationships, scoped to
    // one storyline: a pair can't be stored twice, forward and reversed.
    uniqueIndex('idx_character_relationships_pair').on(
      table.storylineId,
      table.characterAId,
      table.characterBId
    ),
    check('chk_character_relationships_order', sql`${table.characterAId} < ${table.characterBId}`),
  ]
);

export const characterRelationshipsRelations = relations(
  characterRelationships,
  ({ one, many }) => ({
    storyline: one(storylines, {
      fields: [characterRelationships.storylineId],
      references: [storylines.id],
    }),
    characterA: one(characters, {
      fields: [characterRelationships.characterAId],
      references: [characters.id],
      relationName: 'characterA',
    }),
    characterB: one(characters, {
      fields: [characterRelationships.characterBId],
      references: [characters.id],
      relationName: 'characterB',
    }),
    states: many(relationshipStates),
  })
);
