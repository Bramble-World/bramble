import { describe, expect, it } from 'vitest';
import { beatTarget, MAX_BEATS, TranscriptMessage } from './extraction.prompt';

const build = (count: number, spanDays: number): TranscriptMessage[] => {
  const start = Date.UTC(2026, 4, 1);
  const step = count > 1 ? (spanDays * 86_400_000) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => ({
    isFromMe: i % 2 === 0,
    handle: 'thread',
    sender: i % 2 === 0 ? 'me' : 'Great',
    text: 'x',
    sentAt: new Date(start + i * step).toISOString(),
  }));
};

/**
 * The flat cap of 8 was wrong in both directions, and the failure was silent:
 * a four-month founder conversation came back with eight beats, its timeline
 * stopped two months before the story did, and only the arc summary — which
 * reads the whole transcript — knew the rest had happened.
 */
describe('beatTarget', () => {
  it('gives a short exchange the floor rather than a beat per message', () => {
    expect(beatTarget(build(12, 1))).toBe(6);
  });

  it('scales with how much was actually said', () => {
    expect(beatTarget(build(250, 7))).toBe(10);
    expect(beatTarget(build(500, 7))).toBe(20);
  });

  /**
   * The case that motivated this. Sparse but long: not many messages, but four
   * months of them, and things changed across it. Volume alone would have
   * returned the floor and lost the second half again.
   */
  it('uses elapsed time as a floor, so a long sparse thread still gets shape', () => {
    const fourMonths = build(60, 120);
    expect(Math.round(60 / 25)).toBeLessThan(8); // volume alone would say ~2
    expect(beatTarget(fourMonths)).toBe(9); // ~120 days / 14
  });

  it('never exceeds the ceiling, however large the export', () => {
    expect(beatTarget(build(5_000, 900))).toBe(MAX_BEATS);
  });

  // Undated exports are a real shape — the parser reports a null sentAt column
  // rather than refusing — so the span half must simply not contribute.
  it('falls back to volume when the messages carry no usable dates', () => {
    const undated = build(300, 30).map((m) => ({ ...m, sentAt: '' }));
    expect(beatTarget(undated)).toBe(12);
  });

  it('handles a single message without dividing by zero', () => {
    expect(beatTarget(build(1, 0))).toBe(6);
  });
});
