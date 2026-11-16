import { index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { storylines } from '../storylines';
import { storyTurns } from '../storylineSessions/storyTurns';

/**
 * Why a player reported a story. A code, never text: what a player would write
 * is about the story, and story text is not stored twice.
 */
export const storyReportReasonEnum = pgEnum('story_report_reason', [
  'harmful',
  'sexual',
  'hateful',
  'self_harm',
  'real_person',
  'other',
]);

/**
 * Where a report is in review. A report never changes the story on its own:
 * the team reads it first (the user's call, 2026-11-16), then keeps the story
 * or pulls its pool template (`src/scripts/review-reports.ts`).
 */
export const storyReportStatusEnum = pgEnum('story_report_status', ['open', 'kept', 'pulled']);

/**
 * A player saying a story they were given shouldn't be in Bramble.
 *
 * It points at the reporter's own copy — every storyline is one player's — and
 * reaches the shared pool through `storylines.template_id`. Both cascade: a
 * report is the reporter's data and goes with their account or their story.
 *
 * One per player per story: reporting again updates the reason and the beat.
 */
export const storyReports = pgTable(
  'story_reports',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    /** The beat on screen when they reported, when there was one. */
    turnId: uuid('turn_id').references(() => storyTurns.id, { onDelete: 'set null' }),
    reason: storyReportReasonEnum().notNull(),
    status: storyReportStatusEnum().notNull().default('open'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('idx_story_reports_one_per_story').on(table.userId, table.storylineId),
    index('idx_story_reports_open').on(table.status, table.createdAt),
  ]
);
