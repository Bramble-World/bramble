import { and, eq, sql } from 'drizzle-orm';
import { storyTemplates } from '@/db/schema/tables';
import type { StoryTemplate } from '@/lib/pool/template';
import { Executor } from '../executor';

/**
 * How long an answer sits before its story is written.
 *
 * A player often edits an answer within onboarding, and every save would
 * otherwise pay for a story about a sentence they then changed. Saving again
 * replaces the pending row, and with it the wait.
 */
export const SETTLE_MS = 10 * 60_000;

/** Attempts before a template that keeps failing is given up on. */
export const MAX_TEMPLATE_ATTEMPTS = 3;

/** A run older than this is a worker that died without saying so. */
export const TEMPLATE_RECLAIM_AFTER_MS = 15 * 60_000;

/** Exponential, as `retryDelayMs` is for imports. */
export function templateRetryDelayMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1);
}

/**
 * Queues the story for an answer, replacing any story from its earlier text.
 *
 * Replacing rather than keeping: a changed answer is a different past, and a
 * story written from the old one is a story from text the player took back.
 */
export async function enqueueForAnswer(
  tx: Executor,
  userId: string,
  answerId: string,
  now = new Date()
): Promise<void> {
  await tx.delete(storyTemplates).where(eq(storyTemplates.sourceAnswerId, answerId));
  await tx.insert(storyTemplates).values({
    origin: 'reborn',
    userId,
    sourceAnswerId: answerId,
    status: 'pending',
    nextAttemptAt: new Date(now.getTime() + SETTLE_MS),
  });
}

export type ClaimedTemplate = { id: string; sourceAnswerId: string; attempts: number };

/**
 * Takes the next template to write, or null. One statement, `skip locked`, as
 * `claimNextImport` does and for the same reasons.
 *
 * A stale `generating` row is reclaimable whatever its attempts, so a template
 * whose worker died on its last attempt is still seen — and then failed by the
 * runner rather than left `generating` forever. Raw qualifiers inside the
 * subquery, for the reason given on `claimable` in imports.writer.ts.
 */
export async function claimNextTemplate(tx: Executor): Promise<ClaimedTemplate | null> {
  const staleBefore = new Date(Date.now() - TEMPLATE_RECLAIM_AFTER_MS);

  const [row] = await tx
    .update(storyTemplates)
    .set({
      status: 'generating',
      startedAt: new Date(),
      nextAttemptAt: null,
      attempts: sql`${storyTemplates.attempts} + 1`,
    })
    .where(
      sql`"story_templates"."id" = (
        select "t"."id" from "story_templates" "t"
        where "t"."source_answer_id" is not null and (
          (
            "t"."status" = 'pending' and "t"."attempts" < ${MAX_TEMPLATE_ATTEMPTS}
            and ("t"."next_attempt_at" is null or "t"."next_attempt_at" <= now())
          )
          or ("t"."status" = 'generating' and "t"."started_at" < ${staleBefore})
        )
        order by "t"."created_at"
        for update skip locked
        limit 1
      )`
    )
    .returning({
      id: storyTemplates.id,
      sourceAnswerId: storyTemplates.sourceAnswerId,
      attempts: storyTemplates.attempts,
    });

  return row?.sourceAnswerId ? { ...row, sourceAnswerId: row.sourceAnswerId } : null;
}

type Reason = NonNullable<(typeof storyTemplates.$inferInsert)['reason']>;

/**
 * Every outcome is written only while the row is still this run's: if the answer
 * was replaced mid-run, the row is gone, and if another worker reclaimed it, it
 * has a newer attempt. Either way this run's result is discarded.
 */
const ownRun = (claim: ClaimedTemplate) =>
  and(
    eq(storyTemplates.id, claim.id),
    eq(storyTemplates.status, 'generating'),
    eq(storyTemplates.attempts, claim.attempts)
  );

export async function markReady(
  tx: Executor,
  claim: ClaimedTemplate,
  content: StoryTemplate,
  qualityScore: number
): Promise<void> {
  await tx
    .update(storyTemplates)
    .set({ status: 'ready', content, qualityScore, reason: null, updatedAt: new Date() })
    .where(ownRun(claim));
}

/** Declined or rejected: final, and nothing written is kept. */
export async function markRefused(
  tx: Executor,
  claim: ClaimedTemplate,
  status: 'declined' | 'rejected',
  reason: Reason,
  qualityScore: number | null = null
): Promise<void> {
  await tx
    .update(storyTemplates)
    .set({ status, reason, qualityScore, content: null, updatedAt: new Date() })
    .where(ownRun(claim));
}

/** A failure: back in the queue after a wait, or given up on once out of attempts. */
export async function markFailedAttempt(tx: Executor, claim: ClaimedTemplate): Promise<void> {
  const exhausted = claim.attempts >= MAX_TEMPLATE_ATTEMPTS;
  await tx
    .update(storyTemplates)
    .set(
      exhausted
        ? { status: 'failed', reason: 'generation_failed', updatedAt: new Date() }
        : {
            status: 'pending',
            nextAttemptAt: new Date(Date.now() + templateRetryDelayMs(claim.attempts)),
            updatedAt: new Date(),
          }
    )
    .where(ownRun(claim));
}
