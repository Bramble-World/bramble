import { pgTable, uuid, index, jsonb, text, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { storylines } from '../storylines';
import { persons } from '../persons';
import { characterRelationships } from './characterRelationships';
import { eventParticipants } from '../events/eventParticipants';
import { contextEntries } from '../contextEntries';
import { relations } from 'drizzle-orm/_relations';

export const characterRoleEnum = pgEnum('character_role', [
  'protagonist',
  'antagonist',
  'supporting',
]);

export const characters = pgTable(
  'characters',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),

    role: characterRoleEnum().notNull().default('supporting'),
    description: text(), // storyline-specific framing

    // Optional deviation from the person's canonical voice, for this storyline only.
    voiceProfileOverride: jsonb('voice_profile_override').$type<{
      vocabulary?: string[];
      tone?: string;
      quirks?: string[];
    }>(),

    ...timestamps,
  },
  (table) => [
    index('idx_characters_storyline').on(table.storylineId),
    index('idx_characters_person').on(table.personId),
    uniqueIndex('idx_characters_storyline_person').on(table.storylineId, table.personId),
  ]
);

export const charactersRelations = relations(characters, ({ one, many }) => ({
  storyline: one(storylines, {
    fields: [characters.storylineId],
    references: [storylines.id],
  }),
  person: one(persons, {
    fields: [characters.personId],
    references: [persons.id],
  }),
  // Split by side so each end of a pair is reachable, matching the
  // relationNames declared on characterRelationships — the same pattern
  // personsRelations uses for personRelationships.
  relationshipsAsA: many(characterRelationships, { relationName: 'characterA' }),
  relationshipsAsB: many(characterRelationships, { relationName: 'characterB' }),
  eventParticipations: many(eventParticipants),
  contextEntries: many(contextEntries),
}));
