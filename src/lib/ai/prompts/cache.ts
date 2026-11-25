/**
 * Where a prompt may be cut for OpenAI's prompt cache.
 *
 * On GPT-5.6 and later (so on gpt-6-astra) the cache is not a rolling prefix
 * match in 128-token steps, as it was on earlier models. A request can only be
 * served from the cache up to a *boundary*: the end of the system message, the
 * end of a message, or a content block marked with an explicit breakpoint. A
 * prompt sent as one long user message therefore has no boundary inside it,
 * however stable its first ninety thousand tokens are, and every beat paid for
 * all of them again while only the system message was ever read back. That is
 * the ~1,341 cached tokens the logs show on every beat, whatever its size.
 *
 * So a prompt marks, with `CACHE_BREAK` between its lines, the places that end a
 * stretch the *next* request will repeat word for word. The generator sends each
 * stretch as its own text block with a breakpoint after it. The text the model
 * reads is unchanged: the blocks join back into exactly the prompt string.
 *
 * https://developers.openai.com/api/docs/guides/prompt-caching
 */
export const CACHE_BREAK = Symbol('cache break');

export type PromptLine = string | null | typeof CACHE_BREAK;

/**
 * Joins lines as `lines.filter(nonNull).join('\n')` always did, and returns the
 * character offset of each `CACHE_BREAK`. An offset is always at the start of a
 * line, so the stretch before it ends on its newline.
 */
export function joinLines(lines: PromptLine[]): { prompt: string; cacheBreaks: number[] } {
  let prompt = '';
  let first = true;
  const cacheBreaks: number[] = [];
  for (const line of lines) {
    if (line === null) continue;
    if (line === CACHE_BREAK) {
      // A break before anything, or two in a row, marks nothing new.
      const at = first ? 0 : prompt.length + 1;
      if (at > 0 && cacheBreaks.at(-1) !== at) cacheBreaks.push(at);
      continue;
    }
    prompt += first ? line : `\n${line}`;
    first = false;
  }
  // A break after the last line would split off nothing.
  return { prompt, cacheBreaks: cacheBreaks.filter((at) => at < prompt.length) };
}

/**
 * How many beats of a growing list are cut together.
 *
 * A breakpoint is only read back when the next request has a breakpoint in the
 * very same place, so a boundary that moved with every new beat would never
 * match. Instead it steps in fours: two consecutive beats share the boundary
 * until the list grows past the next multiple, and the request that crosses it
 * still carries the previous one, which the beat before had written. A beat adds
 * at most three to the timeline (two consequences and the next scripted beat),
 * so one step is never skipped.
 */
export const CACHE_STEP = 4;

/**
 * Where to cut a list that only grows at its end, given how many of its items
 * are rendered the same way every time they appear (`stable`): the last two
 * multiples of `CACHE_STEP` at or below it, as item counts. 0 is a cut before
 * the first item.
 */
export function steppedBreaks(stable: number): number[] {
  const latest = Math.floor(Math.max(0, stable) / CACHE_STEP) * CACHE_STEP;
  return latest === 0 ? [0] : [latest - CACHE_STEP, latest];
}

/** `items`, with `CACHE_BREAK` before the item at each index in `at`. */
export function withBreaks(items: string[], at: number[]): PromptLine[] {
  const cuts = new Set(at);
  const lines: PromptLine[] = [];
  items.forEach((item, index) => {
    if (cuts.has(index)) lines.push(CACHE_BREAK);
    lines.push(item);
  });
  if (cuts.has(items.length)) lines.push(CACHE_BREAK);
  return lines;
}
/** `text` cut at each offset, ignoring any outside it or out of order. */
export function splitAt(text: string, offsets: number[]): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const at of offsets) {
    if (at <= from || at >= text.length) continue;
    parts.push(text.slice(from, at));
    from = at;
  }
  parts.push(text.slice(from));
  return parts;
}
