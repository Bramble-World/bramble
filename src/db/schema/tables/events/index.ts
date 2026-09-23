import {
  pgTable,
  uuid,
  index,
  uniqueIndex,
  text,
  timestamp,
  integer,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { storylines } from '../storylines';
import { storyTurns } from '../storylineSessions/storyTurns';

export const eventOriginEnum = pgEnum('event_origin', [
  'extracted', // came from the original message-data extraction pipeline
  'conversation_generated', // canon added because the user steered the story via a decision
]);

export const events = pgTable(
  'events',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),

    narrativeOrder: integer('narrative_order').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }), // real-world timestamp, if known

    title: text().notNull(),
    description: text().notNull(),
    stakes: text(),

    origin: eventOriginEnum().notNull().default('extracted'),
    triggeredByTurnId: uuid('triggered_by_turn_id').references(() => storyTurns.id, {
      onDelete: 'set null',
    }),

    // Short LLM-generated explanation of why this beat was created — reasoning,
    // not a pointer to raw source content (raw messages are never persisted;
    // they're only passed to the LLM transiently during generation).
    generationRationale: text('generation_rationale'),

    ...timestamps,
  },
  (table) => [
    index('idx_events_storyline').on(table.storylineId),
    // Unique, not just indexed. Two concurrent consequence writes can otherwise
    // both pick the same gap value and both land, after which the timeline orders
    // arbitrarily and "what was this relationship like at this point" stops being
    // answerable — silently, and permanently. Serves the same lookups as the plain
    // index it replaces.
    uniqueIndex('idx_events_storyline_order').on(table.storylineId, table.narrativeOrder),
    index('idx_events_triggered_by').on(table.triggeredByTurnId),
  ]
);
