import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { env } from '@/env';
import { db } from '@/index';
import { pushDevices, pushSends, storylineSessions, storyTurns, users } from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { withIosClient } from '@/lib/analytics/client-context';
import { ENERGY_WINDOW_MS } from '../sessions/energy.service';
import { apnsConfigured } from './apns';
import { decidePush, MESSAGES, type PushFacts } from './push.policy';
import { sendToUser } from './push.service';
import type { PushKind } from './push.types';

/** The facts `decidePush` needs for one player, or null with no story. */
async function factsFor(userId: string): Promise<{ facts: PushFacts; lastTurnId: string } | null> {
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
    },
  };
}

/** The notifications that are due. Off until `PUSH_ENABLED` says otherwise. */
export async function sweepPush(now = new Date()): Promise<Record<string, number>> {
  const result = { due: 0, delivered: 0, undelivered: 0 };
  if (env.PUSH_ENABLED !== 'true' || !apnsConfigured()) return result;

  const players = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(pushDevices, eq(pushDevices.userId, users.id))
    .where(eq(users.pushEnabled, true));

  for (const { id } of players) {
    const found = await factsFor(id);
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

    const sent = await sendToUser(id, MESSAGES[decision.kind], decision.kind);
    if (sent.delivered > 0) {
      result.delivered += 1;
      // Only iPhones get these, so it goes where the iPhone's events go.
      await withIosClient(() =>
        track(id, { name: 'push_sent', properties: { kind: decision.kind } })
      );
    } else {
      // Nothing arrived, so it doesn't count: the next run tries again.
      await db.delete(pushSends).where(eq(pushSends.id, claimed.id));
      result.undelivered += 1;
    }
  }
  return result;
}
