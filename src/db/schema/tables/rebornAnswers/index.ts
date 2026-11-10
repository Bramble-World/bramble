import { check, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';

/**
 * A reborn player's answer to one of the three questions about their "last
 * life", asked before they sign up (see `POST /api/v1/onboarding/answers`).
 * Each is meant to become a storyline other players live; until then it is
 * only kept.
 *
 * Only answers the safety check passed are here: a flagged answer is never
 * written, and writing one removes the last answer to that question. One row
 * per question per user, so a player who goes back and changes an answer
 * replaces it.
 *
 * `question` is 1–3. `role` is who changed the player's life, and only
 * question 2 has one. `text` is the player's own words about their real life:
 * never logged, never in analytics, never in an error message.
 *
 * Owned by the user like everything else: it moves to the account when a guest
 * claims one, and goes with the account (and with an expired guest).
 */
export const rebornAnswers = pgTable(
  'reborn_answers',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    question: smallint().notNull(),
    role: text(),
    text: text().notNull(),
    ...timestamps,
  },
  (table) => [
    unique('uq_reborn_answers_user_question').on(table.userId, table.question),
    check('chk_reborn_answers_question', sql`${table.question} BETWEEN 1 AND 3`),
    check(
      'chk_reborn_answers_role',
      sql`(${table.question} = 2 AND (${table.role} IS NULL OR ${table.role} IN ('parent', 'ex', 'best_friend', 'teacher', 'boss', 'stranger'))) OR (${table.question} <> 2 AND ${table.role} IS NULL)`
    ),
  ]
);
