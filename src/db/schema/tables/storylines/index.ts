import { pgTable, uuid, text, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { characters } from '../characters';
import { characterRelationships } from '../characters/characterRelationships';
import { events } from '../events';
import { contextEntries } from '../contextEntries';
import { motifOccurrences } from '../motifs/motifOccurrences';
import { storylineSessions } from '../storylineSessions';
import { storylineLinks } from './storylineLinks';
import { relations } from 'drizzle-orm/_relations';

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

    ...timestamps,
  },
  (table) => [index('idx_storylines_user').on(table.userId)]
);

export const storylinesRelations = relations(storylines, ({ one, many }) => ({
  user: one(users, {
    fields: [storylines.userId],
    references: [users.id],
  }),
  characters: many(characters),
  relationships: many(characterRelationships),
  events: many(events),
  contextEntries: many(contextEntries),
  motifOccurrences: many(motifOccurrences),
  sessions: many(storylineSessions),
  linksFrom: many(storylineLinks, { relationName: 'storylineA' }),
  linksTo: many(storylineLinks, { relationName: 'storylineB' }),
}));
