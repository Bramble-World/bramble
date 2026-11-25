import { describe, expect, it, vi } from 'vitest';
import type { PauseFacts } from './pauses';

vi.mock('@/index', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: { PAUSES_ROLLOUT: 'admins' } }));

const { inPauses, localHour, pausesAllowed, pausesArm, replyDueAt, usualHourOf, PAUSE_MIN_BEATS } =
  await import('./pauses');

const facts = (change: Partial<PauseFacts> = {}): PauseFacts => ({
  inFeature: true,
  firstStory: false,
  beatsInDay: PAUSE_MIN_BEATS,
  pausedInDay: false,
  phase: 'open',
  ...change,
});

const NY = 'America/New_York';
const MINUTE = 60 * 1000;

describe('when a beat may pause', () => {
  it('after a good session, in a story that is not the first, while it is open', () => {
    expect(pausesAllowed(facts())).toBe(true);
  });

  it.each([
    ['not in the feature', { inFeature: false }],
    ['in the first story', { firstStory: true }],
    ['before six beats today', { beatsInDay: PAUSE_MIN_BEATS - 1 }],
    ['after a pause today', { pausedInDay: true }],
    ['as the story closes', { phase: 'closing' as const }],
    ['on the last beat', { phase: 'must_end' as const }],
  ])('never %s', (_why, change) => {
    expect(pausesAllowed(facts(change))).toBe(false);
  });
});

describe('who gets pauses', () => {
  it('admins only, by default', () => {
    expect(inPauses('a', true, 'admins')).toBe(true);
    expect(inPauses('a', false, 'admins')).toBe(false);
  });

  it('nobody when off, not even admins', () => {
    expect(inPauses('a', true, 'off')).toBe(false);
  });

  it('in the test, admins and half of players, each fixed', () => {
    expect(inPauses('a', true, 'test')).toBe(true);
    const players = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const inside = players.filter((id) => inPauses(id, false, 'test')).length;
    expect(inside).toBeGreaterThan(430);
    expect(inside).toBeLessThan(570);
    expect(pausesArm('user-7')).toBe(pausesArm('user-7'));
  });
});

describe('when a reply is due', () => {
  // 15:00 in New York.
  const afternoon = new Date('2026-11-25T20:00:00Z');

  it('soon: 30 to 90 minutes', () => {
    expect(replyDueAt('soon', afternoon, NY, 12, () => 0).getTime() - afternoon.getTime()).toBe(
      30 * MINUTE
    );
    expect(replyDueAt('soon', afternoon, NY, 12, () => 0.999).getTime()).toBeLessThan(
      afternoon.getTime() + 90 * MINUTE
    );
  });

  it('tonight: 2 to 4 hours', () => {
    const due = replyDueAt('tonight', afternoon, NY, 12, () => 0.5);
    expect(due.getTime() - afternoon.getTime()).toBe(3 * 60 * MINUTE);
  });

  it('tomorrow: the next local day, at the usual hour', () => {
    const due = replyDueAt('tomorrow', afternoon, NY, 18, () => 0);
    expect(due.toISOString()).toBe('2026-11-26T23:00:00.000Z');
    expect(localHour(due, NY)).toBe(18);
  });

  it('tomorrow is the next day where the reader is, not in UTC', () => {
    // 23:30 in New York is already the 27th in UTC.
    const lateEvening = new Date('2026-11-27T04:30:00Z');
    const due = replyDueAt('tomorrow', lateEvening, NY, 10, () => 0);
    expect(due.toISOString()).toBe('2026-11-27T15:00:00.000Z');
  });

  it('one that would land in quiet hours waits for 09:00 to 09:30', () => {
    // 21:50 in New York: an hour on is 22:50.
    const late = new Date('2026-11-26T02:50:00Z');
    const due = replyDueAt('soon', late, NY, 12, () => 0.5);
    expect(localHour(due, NY)).toBe(9);
    expect(due.toISOString()).toBe('2026-11-26T14:15:00.000Z');
  });

  it('works across a daylight-saving change', () => {
    // The evening of 7 March 2026 in New York, before clocks go forward.
    const before = new Date('2026-03-07T20:00:00Z');
    const due = replyDueAt('tomorrow', before, NY, 10, () => 0);
    expect(localHour(due, NY)).toBe(10);
    expect(due.toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });
});

describe('the usual hour', () => {
  it('is the median of recent beats, kept to 10:00 to 20:00', () => {
    expect(usualHourOf([13, 14, 15])).toBe(14);
    expect(usualHourOf([1, 2, 3])).toBe(10);
    expect(usualHourOf([23, 23])).toBe(20);
  });

  it('is 10:00 with nothing to go on', () => {
    expect(usualHourOf([])).toBe(10);
  });
});
