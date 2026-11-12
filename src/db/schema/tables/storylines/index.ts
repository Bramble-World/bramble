import { pgTable, uuid, text, timestamp, index, pgEnum, integer } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { storyTemplates } from '../storyTemplates';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';

export const storylineStatusEnum = pgEnum('storyline_status', [
  'pending',
  'generating',
  'ready',
  'failed',
]);

export const storylines = pgTable(
  'storylines',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull(),

    sourceSurface: text('source_surface').notNull(), // 'imessage' | 'email' | ...
    setting: text(),
    tone: text(),
    status: storylineStatusEnum().notNull().default('pending'),
    failureReason: text('failure_reason'), // set when status is 'failed'; debugging/user-facing error detail

    // Derived/summary field, recomputed periodically (not on every event) —
    // see arcSummaryGeneratedAt for staleness tracking.
    arcSummary: text('arc_summary'),
    arcSummaryGeneratedAt: timestamp('arc_summary_generated_at', {
      withTimezone: true,
    }), // compare against the latest event's createdAt to know if it's stale

    /**
     * Roughly how many beats this story should take before it ends.
     *
     * A soft budget, not an outline: the model decides when the story lands,
     * and this only says when it may start closing and when it must have closed
     * (see `storyPhase`). Every storyline has one, old ones included, so there
     * is no endless kind of story left to special-case.
     */
    targetBeats: integer('target_beats').notNull().default(20),

    /**
     * The pool story this was copied from. Null for an imported or scripted story.
     *
     * `set null`: when the author leaves, their template goes and this copy stays
     * — it is the player's own story by then. Also how the pool knows what a
     * player has already played.
     */
    templateId: uuid('template_id').references((): AnyPgColumn => storyTemplates.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (table) => [
    index('idx_storylines_user').on(table.userId),
    index('idx_storylines_template').on(table.userId, table.templateId),
  ]
);
