import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { storylines } from '../storylines';

export const importStatusEnum = pgEnum('import_status', ['queued', 'running', 'ready', 'failed']);

/**
 * Where an extraction has got to. Only ever set while `running`.
 *
 * Stages rather than a percentage because extraction is one model call: there
 * is no fraction to report, and inventing one would be a progress bar that
 * jumps from 0 to 100.
 */
export const importStageEnum = pgEnum('import_stage', ['reading', 'writing', 'casting']);

/**
 * One conversation the reader has handed over, and what became of it.
 *
 * **Carries nothing from the transcript.** Not a message, not a sender, not a
 * character count — the row exists so the client can poll for progress and so
 * the account's allowance can be counted, and neither needs the content. The
 * transcript lives as ciphertext in Redis for at most 30 minutes and as
 * plaintext only in the memory of the worker reading it (invariants.md §1).
 *
 * `conversationKey` is the client's own identifier for the thread, opaque here.
 * It is what makes a re-send idempotent: the Mac is the durable copy, so a
 * transcript that expired before the worker got to it is simply sent again, and
 * that must not produce a second import or consume a second slot.
 */
export const imports = pgTable(
  'imports',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** The client's identifier for the conversation. Never a handle or a name. */
    conversationKey: text('conversation_key').notNull(),

    status: importStatusEnum().notNull().default('queued'),
    stage: importStageEnum(),

    /**
     * The storyline this became. Null until the import is `ready`.
     *
     * `set null` rather than `cascade`: deleting a storyline should not erase
     * the record that its conversation was imported, or the reader would
     * silently get a slot back and the import history would disagree with what
     * they remember doing.
     */
    storylineId: uuid('storyline_id').references(() => storylines.id, { onDelete: 'set null' }),

    /**
     * Why it failed, as a code the client can branch on — never a message and
     * never free text from the model, which can echo the prompt and the prompt
     * is the transcript.
     */
    failureCode: text('failure_code'),

    /**
     * When the worker last claimed this import.
     *
     * The sweep needs to tell "queued a moment ago" from "queued half an hour
     * ago and nothing is coming". `updatedAt` cannot answer that: it moves on
     * every stage change, so a job that stalls mid-run looks fresh forever.
     */
    startedAt: timestamp('started_at', { withTimezone: true }),

    ...timestamps,
  },
  (table) => [
    index('idx_imports_user').on(table.userId),
    // One import per conversation per reader. This is the whole of the
    // idempotence guarantee: a re-send collides here rather than being detected
    // by a read that another request can race.
    uniqueIndex('idx_imports_user_conversation').on(table.userId, table.conversationKey),
    // The allowance query — how many of this reader's imports are ready or
    // still in flight — and the sweep's scan for stalled ones.
    index('idx_imports_user_status').on(table.userId, table.status),
  ]
);
