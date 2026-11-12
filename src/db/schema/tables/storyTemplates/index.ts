import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm/sql/sql';
import { timestamps } from '../../../util/timestamps';
import { users } from '../users';
import { rebornAnswers } from '../rebornAnswers';
import type { StoryTemplate } from '@/lib/pool/template';

/** Where a pool story came from. `reddit` is reserved for the later source. */
export const storyTemplateOriginEnum = pgEnum('story_template_origin', [
  'seed',
  'reborn',
  'reddit',
]);

/**
 * A template's way through the job, and its outcome.
 *
 * `declined` and `rejected` are final and are not failures: the first is the
 * writer saying an answer cannot carry a story, the second the check refusing
 * what was written. Quality over quantity — neither is retried.
 */
export const storyTemplateStatusEnum = pgEnum('story_template_status', [
  'pending',
  'generating',
  'ready',
  'declined',
  'rejected',
  'failed',
]);

/**
 * Why a template is not in the pool. A code, never text: the reasons a model
 * gives are written about the answer, and the answer may not be stored twice.
 */
export const storyTemplateReasonEnum = pgEnum('story_template_reason', [
  // The writer declined.
  'too_thin',
  'not_a_story',
  'unclear',
  // The check rejected.
  'identifier',
  'minors',
  'abuse',
  'self_harm',
  'quotes_answer',
  'spoils_opening',
  'low_quality',
  'moderation',
  // The job gave up.
  'generation_failed',
]);

/**
 * The shared pool of stories, and the queue that fills it.
 *
 * The row is the queue, as `imports` is: a worker claims the oldest claimable
 * row with `for update skip locked`. See `src/lib/services/pool`.
 */
export const storyTemplates = pgTable(
  'story_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    origin: storyTemplateOriginEnum().notNull(),

    /**
     * The author: the player whose answer this was written from. Null for a seed.
     *
     * Named `user_id` so the account purge and the guest merge (`USER_OWNED_TABLES`)
     * cover it like every other table a player owns. Deleting the author deletes
     * their templates; players already playing a copy keep it, because a copy is
     * their own rows and only `storylines.template_id` points here, `set null`.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The answer it was written from. Withdrawing or replacing the answer, or the
     * guest expiring, deletes the template with it.
     */
    sourceAnswerId: uuid('source_answer_id').references((): AnyPgColumn => rebornAnswers.id, {
      onDelete: 'cascade',
    }),

    /** A seed's stable name, so the seed script can upsert it. Null otherwise. */
    slug: text().unique(),

    status: storyTemplateStatusEnum().notNull().default('pending'),
    reason: storyTemplateReasonEnum(),

    /** The check's 1–5 score. Kept on rejections too, so the bar can be tuned. */
    qualityScore: smallint('quality_score'),

    /**
     * The story itself, validated by `storyTemplateSchema`. Present only once
     * `ready`: a declined or rejected story is not kept, since it was written
     * from an answer and serves nothing.
     */
    content: jsonb().$type<StoryTemplate>(),

    attempts: integer().notNull().default(0),
    /** Not claimable before this. Also the settle delay after an answer is saved. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),

    ...timestamps,
  },
  (table) => [
    index('idx_story_templates_user').on(table.userId),
    index('idx_story_templates_answer').on(table.sourceAnswerId),
    index('idx_story_templates_claimable')
      .on(table.createdAt)
      .where(sql`${table.status} IN ('pending', 'generating')`),
    index('idx_story_templates_ready')
      .on(table.origin)
      .where(sql`${table.status} = 'ready'`),
  ]
);
