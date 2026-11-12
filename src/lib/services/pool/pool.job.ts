import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { rebornAnswers } from '@/db/schema/tables';
import { Generator, getGenerator } from '@/lib/ai';
import {
  checkPrompt,
  QUALITY_BAR,
  rewritePrompt,
  type PoolAnswer,
} from '@/lib/ai/prompts/pool.prompt';
import { getSafetyCheck, type SafetyCheck } from '@/lib/onboarding/safety';
import { storyTemplateSchema, templateText } from '@/lib/pool/template';
import {
  ClaimedTemplate,
  markFailedAttempt,
  markReady,
  markRefused,
  MAX_TEMPLATE_ATTEMPTS,
} from './pool.writer';

/** The length a pool story is written for. Matches the storylines default. */
export const POOL_TARGET_BEATS = 20;

export type PoolDeps = { generator?: Generator; safety?: SafetyCheck; signal?: AbortSignal };

export type TemplateOutcome = 'ready' | 'declined' | 'rejected' | 'retrying' | 'failed' | 'gone';

/**
 * Writes one pool story from one answer: rewrite, check, moderate, keep or drop.
 *
 * **The answer and the story never leave this function except to the model.**
 * Outcomes are statuses and codes. A thrown error is not logged by the caller
 * either, because its cause chain can carry the prompt.
 *
 * Refusals are final and cost nothing more: a declined answer, a rejected
 * story and a low score are each written once and never retried. Only a
 * failure — the model or moderation unreachable, output that would not parse —
 * goes back in the queue.
 */
export async function runTemplate(
  claim: ClaimedTemplate,
  deps: PoolDeps = {}
): Promise<TemplateOutcome> {
  // A worker died on the last attempt; this claim is only here to close it.
  if (claim.attempts > MAX_TEMPLATE_ATTEMPTS) {
    await markFailedAttempt(db, claim);
    return 'failed';
  }

  const [row] = await db
    .select({
      question: rebornAnswers.question,
      role: rebornAnswers.role,
      text: rebornAnswers.text,
    })
    .from(rebornAnswers)
    .where(eq(rebornAnswers.id, claim.sourceAnswerId))
    .limit(1);
  // Withdrawn between the claim and now; the template went with it.
  if (!row) return 'gone';
  const answer: PoolAnswer = {
    question: row.question as PoolAnswer['question'],
    role: row.role,
    text: row.text,
  };

  const generator = deps.generator ?? getGenerator();
  const safety = deps.safety ?? getSafetyCheck();

  try {
    const { value: written } = await generator.run(
      rewritePrompt,
      { answer, targetBeats: POOL_TARGET_BEATS },
      { signal: deps.signal }
    );

    if (written.verdict === 'declined' || !written.story) {
      await markRefused(db, claim, 'declined', written.declineCode ?? 'not_a_story');
      return 'declined';
    }
    // Parsed again on its own: the union around it is loose by necessity.
    const story = storyTemplateSchema.parse(written.story);

    const { value: checked } = await generator.run(
      checkPrompt,
      { answer, story },
      { signal: deps.signal }
    );
    if (checked.verdict === 'reject') {
      await markRefused(
        db,
        claim,
        'rejected',
        checked.rejectCode ?? 'identifier',
        checked.qualityScore
      );
      return 'rejected';
    }
    if (checked.qualityScore < QUALITY_BAR) {
      await markRefused(db, claim, 'rejected', 'low_quality', checked.qualityScore);
      return 'rejected';
    }

    // The same moderation an answer gets, on everything that would be played.
    const { flagged } = await safety(templateText(story));
    if (flagged) {
      await markRefused(db, claim, 'rejected', 'moderation', checked.qualityScore);
      return 'rejected';
    }

    await markReady(db, claim, story, checked.qualityScore);
    return 'ready';
  } catch {
    await markFailedAttempt(db, claim);
    return claim.attempts >= MAX_TEMPLATE_ATTEMPTS ? 'failed' : 'retrying';
  }
}
