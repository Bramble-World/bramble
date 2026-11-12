import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/index';
import { rebornAnswers } from '@/db/schema/tables';
import { getSafetyCheck, type SafetyCheck } from '@/lib/onboarding/safety';
import { Executor } from '../executor';
import { enqueueForAnswer } from '../pool/pool.writer';

/** Who changed the player's life, on question 2. */
export const REBORN_ROLES = ['parent', 'ex', 'best_friend', 'teacher', 'boss', 'stranger'] as const;
export type RebornRole = (typeof REBORN_ROLES)[number];

export type RebornAnswer = {
  /** 1, 2 or 3. */
  question: number;
  role: RebornRole | null;
  text: string;
};

/**
 * Checks a reborn answer for safety, then keeps it — or, when it's flagged,
 * keeps nothing and removes the last answer to that question, since the
 * player has replaced it.
 *
 * The check comes first and nothing is written if it fails: an answer is never
 * stored unchecked. Nothing here logs the text.
 *
 * A kept answer queues the story written from it (`src/lib/services/pool`),
 * replacing any story from its earlier text.
 */
export async function saveRebornAnswer(
  userId: string,
  answer: RebornAnswer,
  check: SafetyCheck = getSafetyCheck()
): Promise<{ flagged: boolean }> {
  const { flagged } = await check(answer.text);
  if (flagged) {
    await withdrawRebornAnswer(userId, answer.question);
    return { flagged: true };
  }
  // The answer and the story to be written from it are one fact: an answer
  // with no story queued would never become one.
  await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(rebornAnswers)
      .values({ userId, question: answer.question, role: answer.role, text: answer.text })
      .onConflictDoUpdate({
        target: [rebornAnswers.userId, rebornAnswers.question],
        set: { role: answer.role, text: answer.text, updatedAt: new Date() },
      })
      .returning({ id: rebornAnswers.id });
    await enqueueForAnswer(tx, userId, saved.id);
  });
  return { flagged: false };
}

/** "i'd rather not say" after answering. Deleting what isn't there is fine. */
export async function withdrawRebornAnswer(userId: string, question: number): Promise<void> {
  await db
    .delete(rebornAnswers)
    .where(and(eq(rebornAnswers.userId, userId), eq(rebornAnswers.question, question)));
}

/**
 * Before a guest's rows move into an existing account: the guest answered more
 * recently, so the account's answers to the same questions give way. Without
 * this the move would hit the one-answer-per-question constraint.
 */
export async function makeRoomForGuestAnswers(
  tx: Executor,
  guestId: string,
  accountId: string
): Promise<void> {
  const answered = tx
    .select({ question: rebornAnswers.question })
    .from(rebornAnswers)
    .where(eq(rebornAnswers.userId, guestId));
  await tx
    .delete(rebornAnswers)
    .where(and(eq(rebornAnswers.userId, accountId), inArray(rebornAnswers.question, answered)));
}
