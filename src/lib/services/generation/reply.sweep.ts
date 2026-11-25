import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { db } from '@/index';
import { env } from '@/env';
import { pushSends, storylineSessions, users } from '@/db/schema/tables';
import type { Generator } from '@/lib/ai';
import { TURN_DEADLINE_MS, withDeadline } from '@/lib/ai/deadline';
import { failureFields } from '@/lib/ai/failure';
import { track } from '@/lib/analytics/analytics';
import { withIosClient } from '@/lib/analytics/client-context';
import { apnsConfigured } from '../push/apns';
import { storyWaitingMessage } from '../push/push.policy';
import { sendToUser } from '../push/push.service';
import * as sessionReader from '../sessions/sessions.reader';
import * as sessionWriter from '../sessions/sessions.writer';
import { energyFor } from '../sessions/energy.service';
import type { TurnWithChoices } from '../sessions/sessions.types';
import { localHour, timeZoneOf, type ReplyLater } from './pauses';
import { advanceSession } from './turns.service';

/** At most this many replies a run. Usually a handful. */
const LIMIT = 30;
/** Replies are never written into, or announced in, these local hours. */
const QUIET_FROM = 22;
const QUIET_UNTIL = 9;

/**
 * Writes the replies that have come due, and says so by notification (the
 * story texts you; pauses.ts). Every five minutes.
 *
 * A reply is the next beat, written the ordinary way (`advanceSession`): it
 * spends a point of battery, and settles what the last choice changed first.
 * One that finds the reader out of battery waits for the next run with some,
 * and one that would arrive in the reader's quiet hours waits for the morning.
 * A reader who asked for it once it was due already has it: the open turn
 * cleared the due time, and nothing is sent.
 */
export async function sweepReplies(
  deps: { generator?: Generator; now?: Date; limit?: number } = {}
): Promise<Record<string, number>> {
  const now = deps.now ?? new Date();
  const due = await db
    .select({
      sessionId: storylineSessions.id,
      userId: storylineSessions.userId,
      dueAt: storylineSessions.replyDueAt,
      kind: storylineSessions.replyDueKind,
      role: users.role,
      pushEnabled: users.pushEnabled,
    })
    .from(storylineSessions)
    .innerJoin(users, eq(users.id, storylineSessions.userId))
    .where(
      and(
        isNotNull(storylineSessions.replyDueAt),
        lte(storylineSessions.replyDueAt, now),
        isNull(storylineSessions.endedAt)
      )
    )
    .orderBy(asc(storylineSessions.replyDueAt))
    .limit(deps.limit ?? LIMIT);

  const result = { due: due.length, written: 0, notified: 0, quiet: 0, noBattery: 0, failed: 0 };

  for (const reply of due) {
    if (await sessionReader.getOpenTurn(db, reply.sessionId)) {
      // Written already (the reader asked first); only the stamp was left.
      await sessionWriter.clearReplyDue(db, reply.sessionId);
      continue;
    }

    const timeZone = await timeZoneOf(db, reply.userId);
    const hour = localHour(now, timeZone);
    if (hour >= QUIET_FROM || hour < QUIET_UNTIL) {
      result.quiet += 1;
      continue;
    }
    if ((await energyFor(reply.userId, reply.role)).remaining <= 0) {
      result.noBattery += 1;
      continue;
    }

    let turn: TurnWithChoices;
    try {
      turn = await withDeadline(
        (signal) =>
          advanceSession(reply.userId, reply.sessionId, {
            generator: deps.generator,
            signal,
            dueReply: true,
          }),
        TURN_DEADLINE_MS
      );
    } catch (error) {
      // Ids and codes only. The due time stays, so the next run tries again.
      console.warn(
        JSON.stringify({
          event: 'reply_failed',
          sessionId: reply.sessionId,
          ...failureFields(error),
        })
      );
      result.failed += 1;
      continue;
    }
    result.written += 1;

    const kind = (reply.kind ?? 'soon') as ReplyLater;
    await withIosClient(() =>
      track(reply.userId, {
        name: 'reply_arrived',
        properties: {
          delay: kind,
          late_ms: now.getTime() - (reply.dueAt?.getTime() ?? now.getTime()),
        },
      })
    );

    if (await announce(reply.userId, reply.pushEnabled, turn)) result.notified += 1;
  }
  return result;
}

/** How many texts a beat arrives with: a count only, never who or what. */
export function textsIn(turn: Pick<TurnWithChoices, 'surfaces'>): number {
  return turn.surfaces.reduce(
    (count, surface) =>
      surface.type === 'imessage_notifications' ? count + surface.notifications.length : count,
    0
  );
}

/**
 * "2 new texts in your story." Once per reply: the row is claimed before the
 * send, as the push sweep does, and given back if nothing arrived.
 */
async function announce(userId: string, pushEnabled: boolean, turn: TurnWithChoices) {
  if (!pushEnabled || env.PUSH_ENABLED !== 'true' || !apnsConfigured()) return false;

  const [claimed] = await db
    .insert(pushSends)
    .values({ userId, kind: 'reply_arrived', anchorTurnId: turn.id, ordinal: 0 })
    .onConflictDoNothing()
    .returning({ id: pushSends.id });
  if (!claimed) return false;

  const { message } = storyWaitingMessage('texts', textsIn(turn));
  const sent = await sendToUser(userId, message, 'reply_arrived');
  if (sent.delivered === 0) {
    await db.delete(pushSends).where(eq(pushSends.id, claimed.id));
    return false;
  }
  await withIosClient(() =>
    track(userId, { name: 'push_sent', properties: { kind: 'reply_arrived' } })
  );
  return true;
}
