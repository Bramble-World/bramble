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

    /**
     * What this person is trying to get, in this story.
     *
     * The thing that makes a character able to act rather than only respond. A
     * voice profile governs how someone speaks; nothing governed what they were
     * after, so a character the situation did not hand initiative to had no move
     * available except replying to whoever spoke last. Measured before this
     * existed: across 17 generated beats of a three-person storyline, one
     * housemate was the subject of four and the other of none, while being
     * present in eleven.
     *
     * Deliberately something another person can grant or refuse — "wants the
     * three of them to eat together before the move is finished", not "wants to
     * feel respected". A want nobody can withhold generates nothing.
     */
    want: text(),
    /** What they steer around. Null when the conversation never shows one. */
    avoids: text(),

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
