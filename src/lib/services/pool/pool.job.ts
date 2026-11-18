import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { chatgptContexts, rebornAnswers } from '@/db/schema/tables';
import { Generator, getGenerator } from '@/lib/ai';
import {
  checkPrompt,
  QUALITY_BAR,
  rewritePrompt,
  type PoolAnswer,
} from '@/lib/ai/prompts/pool.prompt';
import { personalCheckPrompt, personalRewritePrompt } from '@/lib/ai/prompts/personal.prompt';
import { chatgptContextSchema } from '@/lib/chatgpt/context';
import { getSafetyCheck, type SafetyCheck } from '@/lib/onboarding/safety';
import {
  personalTemplateSchema,
  storyTemplateSchema,
  templateText,
  type StoryTemplate,
} from '@/lib/pool/template';
import {
  ClaimedTemplate,
  forgetContext,
  markFailedAttempt,
  markReady,
  markRefused,
  MAX_TEMPLATE_ATTEMPTS,
} from './pool.writer';

/** The length a pool story is written for. Matches the storylines default. */
export const POOL_TARGET_BEATS = 20;

export type PoolDeps = { generator?: Generator; safety?: SafetyCheck; signal?: AbortSignal };

export type TemplateOutcome = 'ready' | 'declined' | 'rejected' | 'retrying' | 'failed' | 'gone';

type Reason = Parameters<typeof markRefused>[3];

/**
 * One story's way through the models, whatever it is written from: the writer
 * (which may decline), the check (which may reject, and scores it), then the
 * same moderation an answer gets, on everything that would be played.
 */
type Writing = {
  rewrite: (signal?: AbortSignal) => Promise<{
    verdict: 'story' | 'declined';
    declineCode: Reason | null;
    story: unknown;
  }>;
  parse: (story: unknown) => StoryTemplate;
  check: (
    story: StoryTemplate,
    signal?: AbortSignal
  ) => Promise<{ verdict: 'pass' | 'reject'; rejectCode: Reason | null; qualityScore: number }>;
};

async function write(
  claim: ClaimedTemplate,
  writing: Writing,
  safety: SafetyCheck,
  signal?: AbortSignal
): Promise<TemplateOutcome> {
  try {
    const written = await writing.rewrite(signal);
    if (written.verdict === 'declined' || !written.story) {
      await markRefused(db, claim, 'declined', written.declineCode ?? 'not_a_story');
      return 'declined';
    }
    // Parsed again on its own: the union around it is loose by necessity.
    const story = writing.parse(written.story);

    const checked = await writing.check(story, signal);
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

/**
 * Writes one story: a pool story from a reborn answer, or a player's own story
 * from what ChatGPT sent. Rewrite, check, moderate, keep or drop.
 *
 * **What it is written from never leaves this function except to the model.**
 * Outcomes are statuses and codes. A thrown error is not logged by the caller
 * either, because its cause chain can carry the prompt.
 *
 * Refusals are final and cost nothing more: a declined source, a rejected
 * story and a low score are each written once and never retried. Only a
 * failure — the model or moderation unreachable, output that would not parse —
 * goes back in the queue.
 */
export async function runTemplate(
  claim: ClaimedTemplate,
  deps: PoolDeps = {}
): Promise<TemplateOutcome> {
  const generator = deps.generator ?? getGenerator();
  const safety = deps.safety ?? getSafetyCheck();

  if (claim.sourceContextId) {
    const contextId = claim.sourceContextId;
    // A worker died on the last attempt; this claim is only here to close it.
    if (claim.attempts > MAX_TEMPLATE_ATTEMPTS) {
      await markFailedAttempt(db, claim);
      await forgetContext(db, contextId);
      return 'failed';
    }
    const [row] = await db
      .select({ content: chatgptContexts.content })
      .from(chatgptContexts)
      .where(eq(chatgptContexts.id, contextId))
      .limit(1);
    // Deleted with its story between the claim and now.
    if (!row) return 'gone';
    const context = chatgptContextSchema.parse(row.content);

    const outcome = await write(
      claim,
      {
        rewrite: async (signal) =>
          (
            await generator.run(
              personalRewritePrompt,
              { context, targetBeats: POOL_TARGET_BEATS },
              { signal }
            )
          ).value,
        parse: (story) => personalTemplateSchema.parse(story),
        check: async (story, signal) =>
          (await generator.run(personalCheckPrompt, { context, story }, { signal })).value,
      },
      safety,
      deps.signal
    );
    // Finished either way: the story, if there is one, is the only copy now.
    if (outcome !== 'retrying') await forgetContext(db, contextId);
    return outcome;
  }

  // A worker died on the last attempt; this claim is only here to close it.
  if (claim.attempts > MAX_TEMPLATE_ATTEMPTS) {
    await markFailedAttempt(db, claim);
    return 'failed';
  }
  if (!claim.sourceAnswerId) return 'gone';

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

  return write(
    claim,
    {
      rewrite: async (signal) =>
        (await generator.run(rewritePrompt, { answer, targetBeats: POOL_TARGET_BEATS }, { signal }))
          .value,
      parse: (story) => storyTemplateSchema.parse(story),
      check: async (story, signal) =>
        (await generator.run(checkPrompt, { answer, story }, { signal })).value,
    },
    safety,
    deps.signal
  );
}
