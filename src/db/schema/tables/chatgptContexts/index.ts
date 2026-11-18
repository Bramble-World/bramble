import { jsonb, pgTable, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import type { ChatGPTContext } from '@/lib/chatgpt/context';

/**
 * What ChatGPT sent to write one story for its user (`write_my_story`, the MCP
 * tool at `/api/mcp`): a real situation in their life, up to three people in it
 * by name, and who they are.
 *
 * Kept only until the story is written. The pool job deletes the row once its
 * template is ready, declined, rejected or given up on, so afterwards the only
 * copy of any of it is the player's own story. Never logged, never in
 * analytics, never in an error (invariants.md §1).
 *
 * Owned by the user like everything else: it goes with the account.
 */
export const chatgptContexts = pgTable('chatgpt_contexts', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: jsonb().$type<ChatGPTContext>().notNull(),
  ...timestamps,
});
