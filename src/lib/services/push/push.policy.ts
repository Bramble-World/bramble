import { ENERGY_WINDOW_MS, TURN_ENERGY_PER_DAY } from '../sessions/energy.service';
import type { PushKind, PushMessage } from './push.types';

/**
 * Who gets a notification, and when. Pure, so every rule is testable.
 *
 * Two kinds, and the rules are the ones the iPhone's battery reminder kept:
 *
 * - **battery_back:** the player ran out, the first point has returned, and they
 *   haven't played since. Once.
 * - **story_waiting:** a story in progress and a day away, then three days away.
 *   Two at most, and never while they're charging, when they couldn't play.
 *
 * Everyone: between 09:00 and 22:00 where they are, at least 20 hours apart, and
 * nothing after a week away, so nobody hears from a story they've left. A new
 * turn starts it all again, which is also why a player can't be sent more than
 * three in a row.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const QUIET_UNTIL = 9;
const QUIET_FROM = 22;
const MINIMUM_GAP_MS = 20 * HOUR;
const GIVE_UP_AFTER_MS = 7 * DAY;
/** Away this long before the first "story waiting", and the second. */
const WAITING_AFTER_MS = [DAY, 3 * DAY];

export const MESSAGES: Record<PushKind, PushMessage> = {
  battery_back: { title: 'your phone has charged.', body: 'your story’s waiting.' },
  story_waiting: { title: 'your story’s waiting.', body: 'pick up where you left off.' },
};

export type PushFacts = {
  /** The player's latest turn. */
  lastTurnAt: Date;
  /** Turns in the 24 hours up to and including it, and the oldest of them. */
  turnsInWindow: number;
  oldestInWindow: Date;
  /** The last time the app opened, which also says they're around. */
  lastSeenAt: Date;
  timeZone: string;
  /** Sent since the latest turn. */
  sends: { kind: PushKind; sentAt: Date }[];
  /** The last one sent, whenever that was. */
  lastSentAt: Date | null;
};

export type PushDecision = { kind: PushKind; ordinal: number };

function hourIn(timeZone: string, now: Date): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now);
  return Number(hour);
}

export function decidePush(facts: PushFacts, now: Date): PushDecision | null {
  const at = now.getTime();
  const away = Math.max(facts.lastTurnAt.getTime(), facts.lastSeenAt.getTime());

  if (at - facts.lastTurnAt.getTime() > GIVE_UP_AFTER_MS) return null;
  if (facts.lastSentAt && at - facts.lastSentAt.getTime() < MINIMUM_GAP_MS) return null;

  const hour = hourIn(facts.timeZone, now);
  if (hour < QUIET_UNTIL || hour >= QUIET_FROM) return null;

  if (facts.turnsInWindow >= TURN_ENERGY_PER_DAY) {
    const back = facts.oldestInWindow.getTime() + ENERGY_WINDOW_MS;
    if (at < back) return null;
    if (!facts.sends.some((send) => send.kind === 'battery_back')) {
      return { kind: 'battery_back', ordinal: 0 };
    }
  }

  const ordinal = facts.sends.filter((send) => send.kind === 'story_waiting').length;
  const wait = WAITING_AFTER_MS[ordinal];
  if (wait === undefined || at - away < wait) return null;
  return { kind: 'story_waiting', ordinal };
}
