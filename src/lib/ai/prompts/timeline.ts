import type { BeatContext } from '@/lib/services/generation/generation.types';

/**
 * Renders a timeline with the time between beats made explicit.
 *
 * Three prompts show a timeline, and all three showed only the order beats are
 * told in. That is deliberately not when they happened — `narrativeOrder` and
 * `occurredAt` are separate columns precisely because a story can compress or
 * reorder — so a flat list left the model unable to tell whether one beat
 * followed another by an afternoon or by six weeks.
 *
 * The gap is written out rather than left as two timestamps to subtract.
 * "three weeks later" is the fact that matters; the dates are how it is derived,
 * and a model asked to do arithmetic on ISO strings will sometimes get it wrong.
 *
 * Silence carries meaning in these stories — a reply that took a month is a
 * different reply — so the elapsed time is part of the beat, not metadata.
 */
export function renderTimeline(beats: BeatContext[]): string[] {
  let previous: Date | null = null;

  return beats.map((beat) => {
    const when = beat.occurredAt ? new Date(beat.occurredAt) : null;
    const dated = when && !Number.isNaN(when.getTime()) ? when : null;

    const marks: string[] = [];
    if (dated) {
      marks.push(
        dated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      );
      // Measured against the last beat that had a date, so one undated beat in
      // the middle does not silently reset the elapsed time.
      if (previous) {
        const gap = elapsed(previous, dated);
        if (gap) marks.push(gap);
      }
      previous = dated;
    }

    const prefix = marks.length ? `[${marks.join(', ')}] ` : '';
    return `${beat.narrativeOrder}. ${prefix}${beat.title} — ${beat.description}`;
  });
}

/** Plain English for the distance between two beats, or null when it is nothing. */
function elapsed(from: Date, to: Date): string | null {
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);

  if (days <= 0) return 'same day';
  if (days === 1) return 'the next day';
  if (days < 7) return `${days} days later`;
  if (days < 14) return 'a week later';
  if (days < 31) return `${Math.round(days / 7)} weeks later`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return months <= 1 ? 'a month later' : `${months} months later`;
  }
  const years = Math.round(days / 365);
  return years <= 1 ? 'a year later' : `${years} years later`;
}
