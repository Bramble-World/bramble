import { pgTable, uuid, index, uniqueIndex, jsonb, text, boolean } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { sql } from 'drizzle-orm/sql/sql';

export const persons = pgTable(
  'persons',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text().notNull(),
    sourceContactRef: text('source_contact_ref'), // pointer to the real contact/handle, not raw content

    // True for exactly one person per user: the account holder themselves,
    // represented as a person so they can be cast as a character, have a
    // voice profile, and participate in relationships like anyone else.
    isSelf: boolean('is_self').notNull().default(false),

    // Canonical voice, aggregated across all storylines this person appears in.
    voiceProfile: jsonb('voice_profile').$type<{
      vocabulary?: string[];
      tone?: string;
      quirks?: string[];
      sampleTurns?: string[];
    }>(),

    ...timestamps,
  },
  (table) => [
    index('idx_persons_user').on(table.userId),
    uniqueIndex('idx_persons_user_contact').on(table.userId, table.sourceContactRef),
    uniqueIndex('idx_persons_one_self_per_user')
      .on(table.userId)
      .where(sql`${table.isSelf} = true`),
  ]
);
