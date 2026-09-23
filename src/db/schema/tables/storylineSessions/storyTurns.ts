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

    ...timestamps,
  },
  (table) => [
    index('idx_story_turns_session').on(table.sessionId),
    index('idx_story_turns_session_order').on(table.sessionId, table.turnOrder),
    index('idx_story_turns_selected_choice').on(table.selectedChoiceId),
    // A session has at most one turn awaiting an answer. This makes "open the
    // next turn" a get-or-create against the database rather than a convention,
    // so a lost response cannot leave a session with two unanswered turns and no
    // way to tell which one the user is looking at.
    uniqueIndex('idx_story_turns_one_open_per_session')
      .on(table.sessionId)
      .where(sql`${table.selectedChoiceId} IS NULL`),
  ]
);
