import { index, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { storylineSessions } from '../storylineSessions';
import { turnChoices } from './turnChoices';
import { timestamps } from '../../../util/timestamps';
import { integer, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';

export const storyTurns = pgTable(
  'story_turns',
  {
    id: uuid().primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => storylineSessions.id, { onDelete: 'cascade' }),

    turnOrder: integer('turn_order').notNull(),
    narrativeContent: text('narrative_content').notNull(), // what the LLM presented at this decision point
    // The one-sentence hook shown above everything else. Null on turns written
    // before turns had one; those render as narrative and choices alone.
    headline: text(),

    // Filled in once the user answers; null while the turn is awaiting a response.
    //
    // The explicit AnyPgColumn return type is required, not stylistic. This and
    // turn_choices.turn_id reference each other, so inferring either table's type
    // needs the other to be resolved first. TypeScript gives up and falls back to
    // `any` (TS7022). Annotating one side of the cycle gives it a fixed point.
    // The arrow alone only defers evaluation at runtime; it does nothing for the
    // type checker.
    selectedChoiceId: uuid('selected_choice_id').references((): AnyPgColumn => turnChoices.id, {
      onDelete: 'set null',
    }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /**
     * When this turn's consequences were worked out — whatever they came to.
     *
     * Stamped even when the answer was "nothing changed", which is the whole
     * point. Deciding a turn was already handled by looking for a beat that
     * points at it conflates two different states: consequences never computed,
     * and consequences computed and legitimately empty. The consequence prompt
     * is allowed to return nothing, so the second happens often — and an empty
     * result left no trace, so every retry paid for a fresh generation and could
     * write a beat the second time that the first never produced.
     *
     * Null therefore means "still owed", which is what makes a turn answered but
     * not yet resolved a queryable, resumable state rather than a guess.
     */
    consequencesGeneratedAt: timestamp('consequences_generated_at', { withTimezone: true }),

    /**
     * How many times working out this turn's consequences has been started.
     *
     * Counted because `consequences_generated_at` can say "done" and "owed" and
     * nothing else, and the third real state is "tried, and it will not work".
     * The consequence prompt is a pure function of stored state — this turn's
     * narrative, the chosen and rejected labels, the whole timeline — so a
     * failure on it reproduces exactly on every retry. Without a count, the
     * settle-then-generate loop in `advanceSession` retries the same turn
     * forever and the session can never produce another beat.
     *
     * Incremented before the model call and outside the transaction that writes
     * the result. A counter written inside that transaction would roll back with
     * the very failure it exists to count.
     */
    consequenceAttempts: integer('consequence_attempts').notNull().default(0),

    /**
     * When we stopped trying.
     *
     * Kept apart from `consequences_generated_at` rather than folded into it:
     * "resolved, and it changed nothing" and "never resolved, and we gave up"
     * are different facts about the story, and a single stamp meaning both would
     * be the same conflation that made the original idempotence bug.
     *
     * Cleared when a later attempt succeeds, so it reads as a current state
     * rather than a historical event — `consequence_attempts` is what keeps the
     * history.
     */
    consequencesAbandonedAt: timestamp('consequences_abandoned_at', { withTimezone: true }),

    ...timestamps,
  },
  (table) => [
    index('idx_story_turns_session').on(table.sessionId),
    index('idx_story_turns_session_order').on(table.sessionId, table.turnOrder),
    index('idx_story_turns_selected_choice').on(table.selectedChoiceId),
    // Finds the turns that still owe consequences — answered, unresolved, and
    // not given up on — which is the retry question and otherwise a full scan.
    //
    // Abandoned turns are excluded here rather than by a budget comparison in
    // the predicate, so raising or lowering the budget stays a code change
    // instead of a migration.
    index('idx_story_turns_owed_consequences')
      .on(table.sessionId)
      .where(
        sql`${table.selectedChoiceId} IS NOT NULL AND ${table.consequencesGeneratedAt} IS NULL AND ${table.consequencesAbandonedAt} IS NULL`
      ),
    // A session has at most one turn awaiting an answer. This makes "open the
    // next turn" a get-or-create against the database rather than a convention,
    // so a lost response cannot leave a session with two unanswered turns and no
    // way to tell which one the user is looking at.
    uniqueIndex('idx_story_turns_one_open_per_session')
      .on(table.sessionId)
      .where(sql`${table.selectedChoiceId} IS NULL`),
  ]
);
