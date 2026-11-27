import { describe, expect, it } from 'vitest';
import { beatsToEnding, endingBounds, FIRST_STORY_BEATS, storyPhase } from './story-phase';

const pooled = endingBounds({ targetBeats: 20, openingId: null });
const first = endingBounds({ targetBeats: 10, openingId: 'are_you_up' });

describe('storyPhase', () => {
  it('keeps a story open until the closing window', () => {
    expect(storyPhase(1, pooled)).toBe('open');
    expect(storyPhase(15, pooled)).toBe('open');
  });

  it('lets the story close from four beats before the target', () => {
    expect(storyPhase(16, pooled)).toBe('closing');
    expect(storyPhase(23, pooled)).toBe('closing');
  });

  it('requires an ending four beats past the target', () => {
    expect(storyPhase(24, pooled)).toBe('must_end');
    expect(storyPhase(40, pooled)).toBe('must_end');
  });
});

describe('the first story', () => {
  it('ends exactly on its target, 10 or 5', () => {
    expect(first).toEqual({ earliest: 10, latest: 10 });
    expect(endingBounds({ targetBeats: 5, openingId: 'are_you_up' })).toEqual({
      earliest: 5,
      latest: 5,
    });
  });

  it('is 5 beats for everyone', () => {
    expect(FIRST_STORY_BEATS).toBe(5);
  });

  it('at 5, ends on the first beat after the call, counting down from beat 1', () => {
    const short = endingBounds({ targetBeats: 5, openingId: 'are_you_up' });
    for (const beat of [2, 3, 4]) expect(storyPhase(beat, short)).toBe('open');
    expect(storyPhase(5, short)).toBe('must_end');
    expect(beatsToEnding(4, short)).toBe(1);
    expect(beatsToEnding(2, short)).toBe(3);
  });

  it('may not end before beat 10, and must on it', () => {
    for (const beat of [2, 5, 9]) expect(storyPhase(beat, first)).toBe('open');
    expect(storyPhase(10, first)).toBe('must_end');
  });

  it('ends on the next beat when it is already past 10', () => {
    expect(storyPhase(13, first)).toBe('must_end');
  });

  it('counts down to the ending over beats 5 to 9', () => {
    expect(beatsToEnding(4, first)).toBeNull();
    expect(beatsToEnding(5, first)).toBe(5);
    expect(beatsToEnding(9, first)).toBe(1);
    expect(beatsToEnding(10, first)).toBeNull();
  });

  it('leaves every other story to find its own moment', () => {
    expect(beatsToEnding(19, pooled)).toBeNull();
  });
});
