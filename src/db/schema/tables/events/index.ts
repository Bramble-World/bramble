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
import { sql } from 'drizzle-orm/sql/sql';
import { timestamps } from '../../../util/timestamps';
import { storylines } from '../storylines';
import { storyTurns } from '../storylineSessions/storyTurns';
// Safe direction: characters imports storylines and persons, never events, so
// this does not close a cycle.
import { characters } from '../characters';

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

    /**
     * Who set this beat in motion, where one person did.
     *
     * Distinct from `eventParticipants`, which records who was *present* — a
     * distinction that turned out to be the whole of a reported defect. A
     * housemate appeared in eleven of seventeen beats and caused none of them,
     * and there was no way to see that except by reading beat titles, because
     * presence was the only thing stored.
     *
     * Null is legal and common: plenty of beats are something that happened to
     * everyone rather than something one person did.
     *
     * **Read by no prompt.** It exists so "did the cast come alive" is a query
     * rather than a judgement call. Feeding it back to the model would turn
     * choosing who acts into a fairness rota, which is the formula this was
     * trying to escape.
     */
    actorCharacterId: uuid('actor_character_id').references(() => characters.id, {
      onDelete: 'set null',
    }),

    /**
     * How much this beat invites being played from, 1-10, written by the model.
     *
     * The reader is offered a short list of beats to start a new session at, so
     * what is being scored is **"would you want to begin here"** — not how
     * consequential the beat was. Those diverge: the most consequential beat is
     * usually an aftermath, and the best entry point is a confrontation or a
     * question left hanging.
     *
     * Nullable, and null means "never scored" rather than "scored low". Every
     * beat written before this column existed is null, and so is every beat from
     * a model call that omitted it; treating those as zero would conflate "we did
     * not ask" with "the model judged this dull", which is exactly the conflation
     * that made `consequences_generated_at` necessary. The ranked read excludes
     * nulls instead of ordering them last.
     *
     * Scores must be comparable across separate extraction calls, since the
     * ranking spans every storyline a reader has. That is a property of the
     * prompt's rubric, not of this column — see `ENGAGEMENT_RUBRIC`.
     */
    engagementScore: integer('engagement_score'),

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
    index('idx_events_actor').on(table.actorCharacterId),
    // Serves the ranked read behind `GET /api/v1/world`, which runs on every cold
    // start of the client. Partial, because the two predicates it carries are the
    // same two the query always applies: an unscored beat is not rankable and a
    // generated beat is not an entry point.
    index('idx_events_engagement')
      .on(table.storylineId, table.engagementScore)
      .where(sql`${table.engagementScore} IS NOT NULL AND ${table.origin} = 'extracted'`),
  ]
);
