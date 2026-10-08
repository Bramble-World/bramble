import { index, integer, pgTable, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { storylines } from '../storylines';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { events } from '../events';

export const storylineSessions = pgTable(
  'storyline_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    storylineId: uuid('storyline_id')
      .notNull()
      .references(() => storylines.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * How far this playthrough has advanced through the storyline's timeline.
     *
     * Holds a `events.narrativeOrder`, and the turn prompt is shown only beats at
     * or below it — without this the model receives the whole source
     * conversation, including events the reader has not reached, and narrates
     * those instead of inventing what happens next.
     *
     * `0` means "before everything", matching the convention `gapOrderAfter`
     * already uses for an empty timeline. It only ever rises; see invariants.md §6.
     */
    playheadOrder: integer('playhead_order').notNull().default(0),

    /**
     * The beat this playthrough was opened at, when the reader picked one.
     *
     * Null for a session begun from the top, which is every session created
     * before the world screen existed and every one started without a moment.
     *
     * It is the resume key. The reader taps a moment, leaves, taps the same
     * moment a week later and expects to find their playthrough — so "which
     * session is this one" has to be answerable from the id they tapped, and
     * `playheadOrder` cannot answer it: it moves as they play, so a session
     * opened at beat 5 and played to beat 9 is indistinguishable from one opened
     * at 9.
     *
     * `set null` rather than cascade: if the beat is deleted the playthrough is
     * still a real thing the reader did, and erasing it would be a worse answer
     * than orphaning it. It simply stops being resumable from a moment that no
     * longer exists.
     */
    /*
     * The explicit AnyPgColumn return type is required, not stylistic. This
     * closes a cycle — sessions reference events, events reference storyTurns,
     * and storyTurns reference sessions — so inferring any one of them needs the
     * others resolved first and TypeScript falls back to `any` (TS7022). The
     * same annotation on `storyTurns.selectedChoiceId` exists for the same
     * reason. The arrow alone only defers evaluation at runtime; it does nothing
     * for the type checker, and the symptom is distant: unrelated files start
     * reporting implicit `any` on perfectly ordinary callbacks.
     */
    startedFromEventId: uuid('started_from_event_id').references((): AnyPgColumn => events.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (table) => [
    index('idx_storyline_sessions_storyline').on(table.storylineId),
    index('idx_storyline_sessions_user').on(table.userId),
    // Supports the idle sweep: WHERE last_active_at < now() - <threshold>.
    index('idx_storyline_sessions_last_active').on(table.lastActiveAt),
    // The resume lookup: this reader's sessions for one beat, most recent first.
    // Ordered to match the query so the newest row is the index's first hit
    // rather than something found after a sort.
    index('idx_storyline_sessions_from_event').on(
      table.userId,
      table.startedFromEventId,
      table.lastActiveAt.desc()
    ),
  ]
);
