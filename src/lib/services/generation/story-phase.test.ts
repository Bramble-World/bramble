import { describe, expect, it } from 'vitest';
import { storyPhase } from './story-phase';

describe('storyPhase', () => {
  it('keeps a story open until the closing window', () => {
    expect(storyPhase(1, 20)).toBe('open');
    expect(storyPhase(15, 20)).toBe('open');
  });

  it('lets the story close from four beats before the target', () => {
    expect(storyPhase(16, 20)).toBe('closing');
    expect(storyPhase(23, 20)).toBe('closing');
  });

  it('requires an ending four beats past the target', () => {
    expect(storyPhase(24, 20)).toBe('must_end');
    expect(storyPhase(40, 20)).toBe('must_end');
  });
});
