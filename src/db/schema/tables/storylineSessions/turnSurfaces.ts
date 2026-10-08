import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { storyTurns } from './storyTurns';
import { timestamps } from '../../../util/timestamps';

/**
 * The artifacts a turn plays out on — a phone lock screen of texts, an email,
 * a boarding pass. A turn has none (text only), one, or several.
 *
 * Each surface type has its own fields, so they live in `payload` and are
 * validated by that type's schema in `src/lib/surfaces` on the way in and on
 * the way out. `type` is plain text, not an enum, for the same reason as
 * `storylines.source_surface`: a new kind of surface is a code change, never a
 * migration. `version` lets one type's fields change without rewriting rows.
 *
 * Nothing here is a headline or a narrative. Those belong to the turn, which
 * has them whether or not anything is shown on a surface.
 */
export const turnSurfaces = pgTable(
  'turn_surfaces',
  {
    id: uuid().primaryKey().defaultRandom(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => storyTurns.id, { onDelete: 'cascade' }),

    position: integer().notNull(), // display order within the turn
    type: text().notNull(), // 'imessage_notifications' | ...
    version: integer().notNull(),
    payload: jsonb().$type<unknown>().notNull(),

    ...timestamps,
  },
  (table) => [uniqueIndex('idx_turn_surfaces_turn_position').on(table.turnId, table.position)]
);
