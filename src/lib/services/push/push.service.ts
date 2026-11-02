import { and, eq } from 'drizzle-orm';
import { db } from '@/index';
import { pushDevices } from '@/db/schema/tables';
import { sendPush } from './apns';
import type { PushEnvironment, PushMessage } from './push.types';

export type DeviceRegistration = {
  token: string;
  environment: PushEnvironment;
  timeZone: string;
};

/**
 * Records this install against this user. An existing token moves here, because
 * a token addresses an install, and whoever signed in last is who holds the phone.
 */
export async function registerDevice(userId: string, device: DeviceRegistration): Promise<void> {
  const now = new Date();
  await db
    .insert(pushDevices)
    .values({ userId, ...device, lastSeenAt: now })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: {
        userId,
        environment: device.environment,
        timeZone: device.timeZone,
        lastSeenAt: now,
      },
    });
}

/** Scoped to the user, so nobody can stop someone else's notifications. */
export async function removeDevice(userId: string, token: string): Promise<boolean> {
  const removed = await db
    .delete(pushDevices)
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, token)))
    .returning({ id: pushDevices.id });
  return removed.length > 0;
}

export type PushResult = { delivered: number; removed: number; failed: string[] };

/**
 * Sends to every install this user has, one at a time, and deletes any token
 * Apple says is dead. `failed` holds Apple's reasons, never tokens.
 */
export async function sendToUser(userId: string, message: PushMessage): Promise<PushResult> {
  const devices = await db.select().from(pushDevices).where(eq(pushDevices.userId, userId));
  const result: PushResult = { delivered: 0, removed: 0, failed: [] };

  for (const device of devices) {
    const outcome = await sendPush(
      { token: device.token, environment: device.environment as PushEnvironment },
      message
    );
    if (outcome.kind === 'delivered') {
      result.delivered += 1;
    } else if (outcome.kind === 'gone') {
      await db.delete(pushDevices).where(eq(pushDevices.id, device.id));
      result.removed += 1;
    } else {
      result.failed.push(outcome.reason);
    }
  }
  return result;
}
