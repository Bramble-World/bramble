import { pgTable, uuid, index, jsonb } from 'drizzle-orm/pg-core';
import { characterRelationships } from '../characters/characterRelationships';
import { events } from '../events';
import { timestamps } from '../../../util/timestamps';
import { relations } from 'drizzle-orm/_relations';

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

export const relationshipStatesRelations = relations(relationshipStates, ({ one }) => ({
  relationship: one(characterRelationships, {
    fields: [relationshipStates.relationshipId],
    references: [characterRelationships.id],
  }),
  event: one(events, {
    fields: [relationshipStates.eventId],
    references: [events.id],
  }),
}));
