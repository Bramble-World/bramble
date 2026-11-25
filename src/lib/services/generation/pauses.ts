import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '@/index';
import { env } from '@/env';
import { pushDevices, storylineSessions, storyTurns } from '@/db/schema/tables';
import type { Executor } from '../executor';
import * as sessionReader from '../sessions/sessions.reader';
import * as userReader from '../users/users.reader';
import type { StoryPhase } from './story-phase';

/**
 * The story texts you (the user's calls, 2026-11-25): a beat may end with
 * someone replying later, in real time. The reader answers; the next beat is
 * not written until the reply is due, and then the reply sweep writes it and
 * sends a notification. No skip: the wait is the point.
 *
 * The model marks where a story naturally pauses (`replyLater` on the beat).
 * Whether it may is the server's, by `pausesAllowed`: only once the reader has
 * played a good session (`PAUSE_MIN_BEATS` beats in a day), at most once a day,
 * never in the first story, and never as the story closes.
 */

export const REPLY_LATER = ['soon', 'tonight', 'tomorrow'] as const;
export type ReplyLater = (typeof REPLY_LATER)[number];

/** Beats played in the last 24 hours before a pause may come. */
export const PAUSE_MIN_BEATS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Replies never arrive between these local hours; one due then waits for the morning. */
const QUIET_FROM = 22;
const QUIET_UNTIL = 9;
/** `tomorrow` lands near when the reader usually plays, within these hours. */
const USUAL_EARLIEST = 10;
const USUAL_LATEST = 20;
const USUAL_DEFAULT = 10;

export type PausesRollout = 'admins' | 'test' | 'off';
export type PausesArm = 'pauses' | 'none';

/** Half of players, fixed by their id. Its own salt, so it's independent of other tests. */
export function pausesArm(userId: string): PausesArm {
  return createHash('sha256').update(`pauses:${userId}`).digest()[0] % 2 === 0 ? 'pauses' : 'none';
}

/** Whether this reader gets pauses at all under the rollout. Admins always do, unless off. */
export function inPauses(userId: string, admin: boolean, rollout: PausesRollout): boolean {
  if (rollout === 'off') return false;
  if (admin) return true;
  return rollout === 'test' && pausesArm(userId) === 'pauses';
}

export type PauseFacts = {
  inFeature: boolean;
  /** The story was written from a scripted opening: the first one. */
  firstStory: boolean;
  /** Paid beats in the last 24 hours, the one about to be written not counted. */
  beatsInDay: number;
  /** A beat that paused was written in the last 24 hours. */
  pausedInDay: boolean;
  phase: StoryPhase;
};

/** Whether the beat about to be written may pause. Pure, so every rule is testable. */
export function pausesAllowed(facts: PauseFacts): boolean {
  return (
    facts.inFeature &&
    !facts.firstStory &&
    facts.phase === 'open' &&
    facts.beatsInDay >= PAUSE_MIN_BEATS &&
    !facts.pausedInDay
  );
}

// ── Time ─────────────────────────────────────────────────────────────────────

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** The local hour at `at` in `timeZone`, 0–23. */
export function localHour(at: Date, timeZone: string): number {
  return localParts(at, timeZone).hour;
}

/**
 * The instant that reads as this local date and time in `timeZone`. `day` may
 * run past the month's end (Date.UTC rolls it over). Corrected once for the
 * zone's offset at the result, which covers daylight-saving changes.
 */
function atLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const p = localParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant;
  };
  let instant = wanted - offsetAt(wanted);
  instant = wanted - offsetAt(instant);
  return new Date(instant);
}

/**
 * When a reply of this kind is due, from `now`:
 *
 * - `soon`: 30–90 minutes;
 * - `tonight`: 2–4 hours;
 * - `tomorrow`: the next local day, at the reader's usual hour, within half an hour.
 *
 * One that would land in quiet hours (22:00–09:00 local) moves to 09:00–09:30.
 */
export function replyDueAt(
  kind: ReplyLater,
  now: Date,
  timeZone: string,
  usualHour: number,
  random: () => number = Math.random
): Date {
  let due: Date;
  if (kind === 'soon') {
    due = new Date(now.getTime() + 30 * MINUTE_MS + random() * 60 * MINUTE_MS);
  } else if (kind === 'tonight') {
    due = new Date(now.getTime() + 2 * HOUR_MS + random() * 2 * HOUR_MS);
  } else {
    const today = localParts(now, timeZone);
    due = atLocal(
      timeZone,
      today.year,
      today.month,
      today.day + 1,
      usualHour,
      Math.floor(random() * 30)
    );
  }

  const local = localParts(due, timeZone);
  if (local.hour >= QUIET_FROM || local.hour < QUIET_UNTIL) {
    const day = local.hour >= QUIET_FROM ? local.day + 1 : local.day;
    due = atLocal(timeZone, local.year, local.month, day, QUIET_UNTIL, Math.floor(random() * 30));
  }
  return due;
}

/** The median of these local hours, kept within the hours a `tomorrow` reply may land. */
export function usualHourOf(hours: number[]): number {
  if (!hours.length) return USUAL_DEFAULT;
  const sorted = [...hours].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return Math.min(USUAL_LATEST, Math.max(USUAL_EARLIEST, median));
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The reader's time zone, from their most recently seen push device, or UTC without one. */
export async function timeZoneOf(tx: Executor, userId: string): Promise<string> {
  const [device] = await tx
    .select({ timeZone: pushDevices.timeZone })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .orderBy(desc(pushDevices.lastSeenAt))
    .limit(1);
  return device?.timeZone ?? 'UTC';
}

/** The local hours of the reader's beats over the last week. */
async function recentBeatHours(tx: Executor, userId: string, timeZone: string): Promise<number[]> {
  const rows = await tx
    .select({ at: storyTurns.createdAt })
    .from(storyTurns)
    .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
    .where(
      and(
        eq(storylineSessions.userId, userId),
        gte(storyTurns.createdAt, new Date(Date.now() - 7 * DAY_MS))
      )
    );
  return rows.map((row) => localHour(row.at, timeZone));
}

/** When the reply to an answered beat of this kind is due for this reader. */
export async function dueFor(
  tx: Executor,
  userId: string,
  kind: ReplyLater,
  now = new Date()
): Promise<Date> {
  const timeZone = await timeZoneOf(tx, userId);
  const usual = usualHourOf(await recentBeatHours(tx, userId, timeZone));
  return replyDueAt(kind, now, timeZone, usual);
}

/** `pausesAllowed`'s facts for the beat about to be written, read from the database. */
export async function pauseFactsFor(
  userId: string,
  story: { openingId: string | null },
  phase: StoryPhase,
  rollout: PausesRollout = env.PAUSES_ROLLOUT
): Promise<PauseFacts> {
  const admin = await userReader.isAdmin(userId);
  const since = new Date(Date.now() - DAY_MS);
  const [{ used }, [paused]] = await Promise.all([
    sessionReader.turnsCreatedSince(userId, since),
    db
      .select({ id: storyTurns.id })
      .from(storyTurns)
      .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
      .where(
        and(
          eq(storylineSessions.userId, userId),
          isNotNull(storyTurns.replyLater),
          gte(storyTurns.createdAt, since)
        )
      )
      .limit(1),
  ]);
  return {
    inFeature: inPauses(userId, admin, rollout),
    firstStory: story.openingId !== null,
    beatsInDay: used,
    pausedInDay: paused !== undefined,
    phase,
  };
}

/** The `pauses_arm` analytics property: only while the 50/50 test runs, and not for admins. */
export async function pausesArmProperty(
  userId: string,
  rollout: PausesRollout = env.PAUSES_ROLLOUT
): Promise<{ pauses_arm?: PausesArm }> {
  if (rollout !== 'test' || (await userReader.isAdmin(userId))) return {};
  return { pauses_arm: pausesArm(userId) };
}
