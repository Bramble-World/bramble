import { pgTable, uuid, index, jsonb } from 'drizzle-orm/pg-core';
import { characterRelationships } from '../characters/characterRelationships';
import { events } from '../events';
import { timestamps } from '../../../util/timestamps';

export const relationshipStates = pgTable(
  'relationship_states',
  {
    id: uuid().primaryKey().defaultRandom(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => characterRelationships.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }), // the event that caused this shift

    dynamic: jsonb()
      .$type<{
        closeness?: string;
        tension?: string;
        powerBalance?: string;
      }>()
      .notNull(),

    ...timestamps,
  },
  (table) => [
    index('idx_relationship_states_relationship').on(table.relationshipId),
    index('idx_relationship_states_event').on(table.eventId),
  ]
);
