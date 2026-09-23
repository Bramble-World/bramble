import { pgTable, uuid, index, uniqueIndex, check, text } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { persons } from './index';
import { users } from '../users';
import { sql } from 'drizzle-orm/sql/sql';

export const personRelationships = pgTable(
  'person_relationships',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    personAId: uuid('person_a_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    personBId: uuid('person_b_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),

    relationshipType: text('relationship_type'), // "siblings", "close friends", "coworkers"...

    ...timestamps,
  },
  (table) => [
    index('idx_person_relationships_a').on(table.personAId),
    index('idx_person_relationships_b').on(table.personBId),
    // App-layer convention: insert with the lower UUID as personAId, so the
    // same real pair can't end up stored twice in reversed order. Enforced
    // for real by the check constraint below, not just the convention.
    uniqueIndex('idx_person_relationships_pair').on(table.personAId, table.personBId),
    check('chk_person_relationships_order', sql`${table.personAId} < ${table.personBId}`),
  ]
);
