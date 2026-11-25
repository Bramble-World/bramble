import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { env } from '@/env';
import { db } from '@/index';
import {
  pushDevices,
  pushSends,
  storylineSessions,
  storyTurns,
  turnSurfaces,
  users,
} from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { withIosClient } from '@/lib/analytics/client-context';
import { ENERGY_WINDOW_MS } from '../sessions/energy.service';
import { apnsConfigured } from './apns';
import {
  decidePush,
  MESSAGES,
  storyWaitingArm,
  storyWaitingMessage,
  type PushFacts,
} from './push.policy';
import { sendToUser } from './push.service';
import type { PushKind } from './push.types';

/** The facts `decidePush` needs for one player, or null with no story. */
async function factsFor(
  userId: string,
  unlimitedEnergy: boolean
): Promise<{ facts: PushFacts; lastTurnId: string } | null> {
  const [last] = await db
    .select({ id: storyTurns.id, createdAt: storyTurns.createdAt })
    .from(storyTurns)
    .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
    .where(eq(storylineSessions.userId, userId))
    .orderBy(desc(storyTurns.createdAt))
    .limit(1);
  if (!last) return null;

  const [window] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string>`min(${storyTurns.createdAt})`,
    })
    .from(storyTurns)
    .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
    .where(
      and(
        eq(storylineSessions.userId, userId),
        gte(storyTurns.createdAt, new Date(last.createdAt.getTime() - ENERGY_WINDOW_MS)),
        lte(storyTurns.createdAt, last.createdAt),
        // Counted as energy counts them: a free beat spent nothing.
        eq(storyTurns.free, false)
      )
    );

  const [device] = await db
    .select({ lastSeenAt: pushDevices.lastSeenAt, timeZone: pushDevices.timeZone })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .orderBy(desc(pushDevices.lastSeenAt))
    .limit(1);
  if (!device) return null;

  const sends = await db
    .select({ kind: pushSends.kind, sentAt: pushSends.sentAt, anchor: pushSends.anchorTurnId })
    .from(pushSends)
    .where(eq(pushSends.userId, userId))
    .orderBy(desc(pushSends.sentAt));

  const [owed] = await db
    .select({ id: storylineSessions.id })
    .from(storylineSessions)
    .where(and(eq(storylineSessions.userId, userId), isNotNull(storylineSessions.replyDueAt)))
    .limit(1);

  return {
    lastTurnId: last.id,
    facts: {
      lastTurnAt: last.createdAt,
      turnsInWindow: window.count,
      oldestInWindow: new Date(window.oldest),
      lastSeenAt: device.lastSeenAt,
      timeZone: device.timeZone,
      sends: sends
        .filter((send) => send.anchor === last.id)
        .map((send) => ({ kind: send.kind as PushKind, sentAt: send.sentAt })),
      lastSentAt: sends[0]?.sentAt ?? null,
      unlimitedEnergy,
      replyOwed: owed !== undefined,
    },
  };
}

/**
 * How many texts the player's latest beat has, if it's still waiting for an
 * answer; 0 if it was answered, is an ending, or has no texts. A count only:
 * who sent them and what they say never leave here.
 */
async function waitingTexts(turnId: string): Promise<number> {
  const [row] = await db
    .select({
      texts: sql<number>`coalesce(sum(jsonb_array_length(${turnSurfaces.payload} -> 'notifications')), 0)::int`,
    })
    .from(storyTurns)
    .leftJoin(
      turnSurfaces,
      and(eq(turnSurfaces.turnId, storyTurns.id), eq(turnSurfaces.type, 'imessage_notifications'))
    )
    .where(
      and(
        eq(storyTurns.id, turnId),
        isNull(storyTurns.selectedChoiceId),
        eq(storyTurns.isEnding, false)
      )
    );
  return row?.texts ?? 0;
}

/** The notifications that are due. Off until `PUSH_ENABLED` says otherwise. */
export async function sweepPush(now = new Date()): Promise<Record<string, number>> {
  const result = { due: 0, delivered: 0, undelivered: 0 };
  if (env.PUSH_ENABLED !== 'true' || !apnsConfigured()) return result;

  const players = await db
    .selectDistinct({ id: users.id, role: users.role })
    .from(users)
    .innerJoin(pushDevices, eq(pushDevices.userId, users.id))
    .where(eq(users.pushEnabled, true));

  for (const { id, role } of players) {
    const found = await factsFor(id, role === 'admin');
    const decision = found && decidePush(found.facts, now);
    if (!found || !decision) continue;
    result.due += 1;

    // Written first: if this run is repeated, the unique index stops a second send.
    const [claimed] = await db
      .insert(pushSends)
      .values({
        userId: id,
        kind: decision.kind,
        anchorTurnId: found.lastTurnId,
        ordinal: decision.ordinal,
      })
      .onConflictDoNothing()
      .returning({ id: pushSends.id });
    if (!claimed) continue;

    const { message, copy } =
      decision.kind === 'story_waiting'
        ? storyWaitingMessage(storyWaitingArm(id), await waitingTexts(found.lastTurnId))
        : { message: MESSAGES[decision.kind], copy: undefined };
    const sent = await sendToUser(id, message, decision.kind);
    if (sent.delivered > 0) {
      result.delivered += 1;
      // Only iPhones get these, so it goes where the iPhone's events go.
      await withIosClient(() =>
        track(id, {
          name: 'push_sent',
          properties: { kind: decision.kind, ...(copy ? { copy } : {}) },
        })
      );
    } else {
      // Nothing arrived, so it doesn't count: the next run tries again.
      await db.delete(pushSends).where(eq(pushSends.id, claimed.id));
      result.undelivered += 1;
    }
  }
  return result;
}
