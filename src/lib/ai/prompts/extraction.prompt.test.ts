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

  // Both values sit strictly below the ceiling, so this measures scaling rather
  // than clamping. 500 messages would land exactly on MAX_BEATS and pass either
  // way, which is no test at all.
  it('scales with how much was actually said', () => {
    expect(beatTarget(build(250, 7))).toBe(10);
    expect(beatTarget(build(400, 7))).toBe(16);
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

  /**
   * Pins the value, not just the behaviour.
   *
   * The other cases assert `toBe(MAX_BEATS)`, which adapts to whatever the
   * constant happens to say — so raising it would break nothing and silently
   * restore a real outage. This ceiling is bounded by transport rather than by
   * taste: the extraction call is non-streaming, so no response headers arrive
   * until the whole object exists, and Node's fetch abandons the request after
   * 300 seconds of waiting. At 40 a dense conversation crossed that line and
   * failed with UND_ERR_HEADERS_TIMEOUT, no status code, three identical
   * retries and nothing to show for it.
   *
   * Raising this is legitimate — after the transport is fixed, with a longer
   * header timeout or by streaming. Not before.
   */
  it('keeps the ceiling where the transport can survive it', () => {
    expect(MAX_BEATS).toBe(20);
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
