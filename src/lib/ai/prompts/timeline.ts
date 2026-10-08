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
 *
 * What is at risk rides along on the recent beats. `stakes` is extracted for
 * most beats, reads well, and until now was shown to nothing at all — so the
 * model was told what happened and never why it mattered, which is most of why
 * the beats it wrote back were flat. It is windowed rather than rendered
 * throughout because stakes run ~90 characters and a timeline may now hold 40
 * beats; the older ones are context, and only the recent ones are pressure.
 */
const STAKES_WINDOW = 5;

export function renderTimeline(beats: BeatContext[]): string[] {
  let previous: Date | null = null;
  const stakesFrom = Math.max(0, beats.length - STAKES_WINDOW);

  return beats.map((beat, index) => {
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
    const line = `${beat.narrativeOrder}. ${prefix}${beat.title} — ${beat.description}`;

    // Guarded on trim rather than null: the consequence schema permits an empty
    // string, and a bare "At stake:" with nothing behind it is worse than
    // saying nothing.
    const stakes = index >= stakesFrom ? beat.stakes?.trim() : undefined;
    return stakes ? `${line}\n  At stake: ${stakes}` : line;
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

/**
 * How a beat earns its engagement score, worded identically for every prompt
 * that writes one.
 *
 * **One constant, two prompts, for one reason.** The reader's list spans every
 * storyline they own, so a 7 from one extraction has to mean what a 7 from
 * another means. Two copies of this text would drift, and drift looks exactly
 * like a model being inconsistent — the rubric would appear to be failing when
 * really the prompts had stopped agreeing.
 *
 * The anchors are **absolute on purpose**. A model asked to rate beats "relative
 * to this conversation" gives its strongest one a 9 every time, so three
 * storylines produce three 9s, the ranking collapses into ties, and the order
 * inside them is arbitrary. Describing what a 2 and a 9 look like in *any*
 * conversation is what makes one scale out of separate calls.
 *
 * It scores **"would you want to start playing here"**, which is not "how much
 * this beat changed". The two come apart constantly: the most consequential beat
 * in a story is usually its aftermath, and the one worth opening on is a
 * confrontation, a question left hanging, or a decision about to be taken. The
 * list exists so a reader can pick an entry point, so that is what is measured.
 */
export const ENGAGEMENT_RUBRIC = [
  'engagementScore, 1-10: how much this beat invites someone to start playing',
  'from it. Not how important it was — the most important beat in a story is',
  'usually its quiet aftermath, and that is a poor place to begin.',
  '',
  'Score against these descriptions, never against the other beats in this',
  'conversation. Two different conversations must be able to produce the same',
  'number and mean the same thing by it, so do not grade on a curve and do not',
  'feel obliged to use the whole range.',
  '',
  '  1-2  Nothing is in motion. Logistics, a plan confirmed, pleasantries.',
  '       Beginning here would give a reader nothing to do.',
  '  3-4  Something shifts, but quietly and between only one or two people.',
  '       Context for what comes later rather than a place to open.',
  '  5-6  A real moment with a live question in it, where someone could',
  '       plausibly have acted differently.',
  '  7-8  Pressure. Something is being asked, refused, risked or avoided, and',
  '       what happens next genuinely depends on what the reader does.',
  '  9-10 The hinge of the story. A confrontation, a decision taken or dodged,',
  '       something said that cannot be unsaid. Reserve these: most',
  '       conversations contain one or two, and many contain none.',
].join('\n');
