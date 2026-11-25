import { describe, expect, it } from 'vitest';
import {
  decidePush,
  MESSAGES,
  storyWaitingArm,
  storyWaitingMessage,
  type PushFacts,
} from './push.policy';

const HOUR = 60 * 60 * 1000;
/** 15:00 in New York. */
const NOW = new Date('2026-11-04T20:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function facts(change: Partial<PushFacts> = {}): PushFacts {
  return {
    lastTurnAt: ago(30),
    turnsInWindow: 5,
    oldestInWindow: ago(32),
    lastSeenAt: ago(30),
    timeZone: 'America/New_York',
    sends: [],
    lastSentAt: null,
    unlimitedEnergy: false,
    ...change,
  };
}

const ranOut = { turnsInWindow: 20, oldestInWindow: ago(26) };

describe('battery_back', () => {
  it('goes once the first point is back', () => {
    expect(decidePush(facts(ranOut), NOW)).toEqual({ kind: 'battery_back', ordinal: 0 });
  });

  it('never goes to an admin, whose battery never ran out', () => {
    expect(decidePush(facts({ ...ranOut, unlimitedEnergy: true }), NOW)).toEqual({
      kind: 'story_waiting',
      ordinal: 0,
    });
  });

  it('waits while the phone is still charging, and sends nothing else', () => {
    const charging = facts({
      turnsInWindow: 20,
      oldestInWindow: ago(10),
      lastTurnAt: ago(2),
      lastSeenAt: ago(2),
    });
    expect(decidePush(charging, NOW)).toBeNull();
  });

  it('goes once', () => {
    const sent = facts({
      ...ranOut,
      lastTurnAt: ago(25),
      lastSeenAt: ago(25),
      sends: [{ kind: 'battery_back', sentAt: ago(21) }],
      lastSentAt: ago(21),
    });
    expect(decidePush(sent, NOW)?.kind).not.toBe('battery_back');
  });
});

describe('story_waiting', () => {
  it('not before a day away', () => {
    expect(decidePush(facts({ lastTurnAt: ago(23), lastSeenAt: ago(23) }), NOW)).toBeNull();
  });

  it('goes after a day away', () => {
    expect(decidePush(facts(), NOW)).toEqual({ kind: 'story_waiting', ordinal: 0 });
  });

  it('counts opening the app as being here', () => {
    expect(decidePush(facts({ lastSeenAt: ago(2) }), NOW)).toBeNull();
  });

  it('goes again at three days, then stops', () => {
    const one = [{ kind: 'story_waiting' as const, sentAt: ago(50) }];
    expect(
      decidePush(
        facts({ lastTurnAt: ago(70), lastSeenAt: ago(70), sends: one, lastSentAt: ago(50) }),
        NOW
      )
    ).toBeNull();
    expect(
      decidePush(
        facts({ lastTurnAt: ago(73), lastSeenAt: ago(73), sends: one, lastSentAt: ago(49) }),
        NOW
      )
    ).toEqual({ kind: 'story_waiting', ordinal: 1 });

    const two = [...one, { kind: 'story_waiting' as const, sentAt: ago(25) }];
    expect(
      decidePush(
        facts({ lastTurnAt: ago(100), lastSeenAt: ago(100), sends: two, lastSentAt: ago(25) }),
        NOW
      )
    ).toBeNull();
  });
});

describe('every notification', () => {
  it('stays out of the night, where the player is', () => {
    expect(decidePush(facts({ timeZone: 'Asia/Tokyo' }), NOW)).toBeNull();
  });

  it('waits 20 hours since the last one, whatever it was about', () => {
    expect(decidePush(facts({ lastSentAt: ago(19) }), NOW)).toBeNull();
  });

  it('gives up after a week away', () => {
    expect(decidePush(facts({ lastTurnAt: ago(169), lastSeenAt: ago(169) }), NOW)).toBeNull();
  });

  it('never carries a name: the text is fixed', () => {
    expect(Object.values(MESSAGES).flatMap((m) => [m.title, m.body])).toEqual([
      'your phone has charged.',
      'your story’s waiting.',
      'your story’s waiting.',
      'pick up where you left off.',
      'your story’s ready.',
      'made from your life. it’s on your desk.',
      'your story’s waiting on your choice.',
      'pick up where you left off.',
    ]);
  });
});

describe('the story waiting wording test', () => {
  it('keeps a player in one arm, and splits players about evenly', () => {
    expect(storyWaitingArm('a-user')).toBe(storyWaitingArm('a-user'));
    const arms = Array.from({ length: 1000 }, (_, i) => storyWaitingArm(`user-${i}`));
    const texts = arms.filter((arm) => arm === 'texts').length;
    expect(texts).toBeGreaterThan(430);
    expect(texts).toBeLessThan(570);
  });

  it("today's arm sends today's words", () => {
    expect(storyWaitingMessage('today', 3)).toEqual({
      message: MESSAGES.story_waiting,
      copy: 'today',
    });
  });

  it('counts the waiting texts, and never says who', () => {
    expect(storyWaitingMessage('texts', 2)).toEqual({
      message: { title: '2 new texts in your story.', body: 'they’re waiting on your answer.' },
      copy: 'texts',
    });
    expect(storyWaitingMessage('texts', 1).message.title).toBe('1 new text in your story.');
  });

  it('with no texts waiting, says the story is waiting on a choice', () => {
    expect(storyWaitingMessage('texts', 0)).toEqual({
      message: {
        title: 'your story’s waiting on your choice.',
        body: 'pick up where you left off.',
      },
      copy: 'choice',
    });
  });
});

describe('a reply owed', () => {
  it('holds back "story waiting": the reply sends its own', () => {
    expect(decidePush(facts({ replyOwed: true }), NOW)).toBeNull();
  });
});
