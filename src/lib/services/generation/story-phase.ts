/**
 * Where a story is in its length, which decides what the turn prompt allows.
 *
 * The model decides when a story ends; this only bounds it. Before the closing
 * window an ending is refused, inside it the model may end the story when it
 * lands, and at the last beat it must. A soft budget rather than an outline, so
 * a story can run a few beats long when the ending is not there yet.
 *
 * The first story is the exception: it ends on its target beat exactly
 * (`FIRST_STORY_BEATS`), and the beats before it are told how far off it is,
 * so it builds to an ending rather than stopping (`beatsToEnding`).
 */
export type StoryPhase = 'open' | 'closing' | 'must_end';

/** Beats either side of the target: the window opens this many before it and closes this many after. */
export const CLOSING_WINDOW = 4;

/**
 * The first story's last beat, kept as its `targetBeats`: the first beat on the
 * desk, right after signing up, is the ending. 5 for everyone since 2026-11-27
 * (the user's call), ending the 5-against-10 test of 2026-11-25: 5 got more
 * players to a second story, and the goal is getting them to the story made from
 * their own life as soon as possible. First stories written at 10 before then
 * keep their length. Each first story's beats still carry `first_story_beats` in
 * analytics (docs/metrics.md).
 */
export const FIRST_STORY_BEATS = 5;

/** How many beats before a fixed ending the turn prompt starts counting down to it. */
export const BUILD_UP_BEATS = 5;

/**
 * The earliest beat that may be the ending, and the beat that must be. 1-based
 * positions in the playthrough, counting a scripted first beat.
 */
export type EndingBounds = { earliest: number; latest: number };

/**
 * A story's ending bounds. The first story (the one written from a scripted
 * opening, `storylines.opening_id`) ends exactly on its `targetBeats`; every
 * other one between four beats either side of it.
 */
export function endingBounds(story: {
  targetBeats: number;
  openingId: string | null;
}): EndingBounds {
  if (story.openingId !== null) {
    return { earliest: story.targetBeats, latest: story.targetBeats };
  }
  return {
    earliest: story.targetBeats - CLOSING_WINDOW,
    latest: story.targetBeats + CLOSING_WINDOW,
  };
}

/** `beat` is the 1-based position of the beat about to be written. */
export function storyPhase(beat: number, bounds: EndingBounds): StoryPhase {
  if (beat >= bounds.latest) return 'must_end';
  if (beat >= bounds.earliest) return 'closing';
  return 'open';
}

/**
 * For a story whose ending is a fixed beat, how many beats after this one it
 * comes, in the last `BUILD_UP_BEATS` before it: on a 10-beat first story, 5 on
 * beat 5 and 1 on beat 9. Null otherwise — a story with a window decides its own
 * moment, and one far from its end has no reason to hear about it.
 */
export function beatsToEnding(beat: number, bounds: EndingBounds): number | null {
  if (bounds.earliest !== bounds.latest) return null;
  const left = bounds.latest - beat;
  return left >= 1 && left <= BUILD_UP_BEATS ? left : null;
}
