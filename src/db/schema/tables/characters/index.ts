import { pgTable, uuid, index, jsonb, text, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { storylines } from '../storylines';
import { persons } from '../persons';

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
