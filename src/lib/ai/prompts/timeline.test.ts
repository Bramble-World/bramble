import { describe, expect, it } from 'vitest';
import type { BeatContext } from '@/lib/services/generation/generation.types';
import { renderTimeline } from './timeline';

const beat = (n: number, occurredAt: string | null, title = `Beat ${n}`): BeatContext => ({
  id: String(n),
  narrativeOrder: n,
  title,
  description: 'what happened',
  stakes: null,
  origin: 'extracted',
  occurredAt,
  participantCharacterIds: [],
});

describe('renderTimeline', () => {
  it('keeps the order, the title and the description', () => {
    const [line] = renderTimeline([beat(1000, null, 'Where things stood')]);
    expect(line).toBe('1000. Where things stood — what happened');
  });

  // The gap is the point. A model asked to subtract two ISO strings will
  // sometimes get it wrong, and the elapsed time is what carries meaning.
  it.each([
    ['2026-07-14T09:00:00Z', 'the next day'],
    ['2026-07-16T09:00:00Z', '3 days later'],
    ['2026-07-20T09:00:00Z', 'a week later'],
    ['2026-08-02T09:00:00Z', '3 weeks later'],
    ['2026-09-13T09:00:00Z', '2 months later'],
  ])('describes the distance to %s as "%s"', (second, expected) => {
    const lines = renderTimeline([beat(1000, '2026-07-13T09:00:00Z'), beat(2000, second)]);
    expect(lines[1]).toContain(expected);
  });

  it('says nothing about a gap for the first dated beat', () => {
    const [line] = renderTimeline([beat(1000, '2026-07-13T09:00:00Z')]);
    expect(line).toContain('13 Jul 2026');
    expect(line).not.toMatch(/later|same day/);
  });

  it('treats two beats on one day as the same day', () => {
    const lines = renderTimeline([
      beat(1000, '2026-07-13T09:00:00Z'),
      beat(2000, '2026-07-13T18:00:00Z'),
    ]);
    expect(lines[1]).toContain('same day');
  });

  // Consequence-generated beats have no real-world date, and sit between dated
  // ones. An undated beat must not reset the clock, or the beat after it would
  // report its distance from nothing.
  it('measures across an undated beat rather than resetting', () => {
    const lines = renderTimeline([
      beat(1000, '2026-07-13T09:00:00Z'),
      beat(1500, null),
      beat(2000, '2026-07-20T09:00:00Z'),
    ]);

    expect(lines[1]).toBe('1500. Beat 1500 — what happened');
    expect(lines[2]).toContain('a week later');
  });

  it('ignores a date that will not parse', () => {
    const [line] = renderTimeline([beat(1000, 'the third of never')]);
    expect(line).toBe('1000. Beat 1000 — what happened');
  });

  it('leaves an entirely undated timeline exactly as it was', () => {
    const lines = renderTimeline([beat(1000, null), beat(2000, null)]);
    expect(lines).toStrictEqual([
      '1000. Beat 1000 — what happened',
      '2000. Beat 2000 — what happened',
    ]);
  });
});
