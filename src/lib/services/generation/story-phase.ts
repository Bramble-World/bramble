/**
 * Where a story is in its length, which decides what the turn prompt allows.
 *
 * The model decides when a story ends; this only bounds it. Before the closing
 * window an ending is refused, inside it the model may end the story when it
 * lands, and past the cap it must. A soft budget rather than an outline, so a
 * story can run a few beats long when the ending is not there yet.
 */
export type StoryPhase = 'open' | 'closing' | 'must_end';

/** Beats either side of the target: the window opens this many before it and closes this many after. */
export const CLOSING_WINDOW = 4;

/** `beat` is the 1-based position of the beat about to be written. */
export function storyPhase(beat: number, targetBeats: number): StoryPhase {
  if (beat >= targetBeats + CLOSING_WINDOW) return 'must_end';
  if (beat >= targetBeats - CLOSING_WINDOW) return 'closing';
  return 'open';
}
