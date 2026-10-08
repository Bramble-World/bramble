import { pgTable, uuid, index, primaryKey } from 'drizzle-orm/pg-core';
import { characters } from '../characters';
import { events } from './index';

export const eventParticipants = pgTable(
  'event_participants',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.characterId] }),
    index('idx_event_participants_character').on(table.characterId),
  ]
);
