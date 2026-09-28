import { describe, expect, it } from 'vitest';
import type { BeatContext } from '@/lib/services/generation/generation.types';
import { renderTimeline } from './timeline';

const withStakes = (b: BeatContext, stakes: string | null): BeatContext => ({ ...b, stakes });

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

/**
 * What is at risk.
 *
 * `stakes` was extracted for most beats, read well, and was shown to nothing —
 * so the model was told what happened and never why it mattered. That is most
 * of why the beats it wrote back were flat.
 */
describe('stakes', () => {
  it('puts what is at risk under the beat it belongs to', () => {
    const [line] = renderTimeline([
      withStakes(beat(1000, null, 'Where things stood'), 'Whether it gets named at all.'),
    ]);

    // The whole element, so this pins the format and not merely the presence of
    // the words — `toContain('At stake')` would pass on a label with nothing
    // behind it.
    expect(line).toBe(
      '1000. Where things stood — what happened\n  At stake: Whether it gets named at all.'
    );
  });

  it('says nothing when the stakes are blank rather than absent', () => {
    const [line] = renderTimeline([withStakes(beat(1000, null), '   ')]);
    expect(line).toBe('1000. Beat 1000 — what happened');
  });

  // Stakes run ~90 characters and a timeline may hold 40 beats. The old ones are
  // context; only the recent ones are pressure.
  it('carries stakes on the recent beats and not the whole history', () => {
    const beats = Array.from({ length: 8 }, (_, i) =>
      withStakes(beat((i + 1) * 1000, null), `risk ${i + 1}`)
    );

    const lines = renderTimeline(beats);

    expect(lines[0]).not.toContain('At stake');
    expect(lines[2]).not.toContain('At stake');
    expect(lines[3]).toContain('At stake: risk 4');
    expect(lines[7]).toContain('At stake: risk 8');
  });
});
