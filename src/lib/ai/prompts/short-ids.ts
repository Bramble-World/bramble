/**
 * Short handles for the ids a prompt shows the model and the model writes back.
 *
 * A uuid costs about twenty tokens each way, and the beat and consequence
 * prompts list every character and relationship by id while their output names
 * senders, participants, actors and relationships by id: a third of a
 * consequence's written output was uuids. Output is the expensive side, so the
 * model sees and writes the first few hex digits instead, and the caller maps
 * them back before anything is stored or streamed.
 *
 * Taken from the id itself rather than numbered by position, so a character's
 * handle never changes as the cast grows or is cut to the people the reader has
 * met. The prompt therefore stays byte-identical where it repeats, which is what
 * the cache needs (cache.ts).
 */
const LENGTH = 6;

export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, LENGTH).toLowerCase();
}

/**
 * Reads a handle the model wrote back as one of `ids`, or undefined.
 *
 * A full id is accepted too, so output written before this change (and the
 * test fakes, which know the real ids) still resolves. A handle that is unknown
 * or, by a one-in-millions chance, shared by two of `ids` resolves to nothing,
 * and callers already drop an id they do not recognise rather than guess.
 */
export function idResolver(
  ids: Iterable<string>
): (handle: string | null | undefined) => string | undefined {
  const full = new Set<string>();
  const byHandle = new Map<string, string | null>();
  for (const id of ids) {
    full.add(id);
    const handle = shortId(id);
    byHandle.set(handle, byHandle.has(handle) ? null : id);
  }
  return (handle) => {
    if (!handle) return undefined;
    const written = handle.trim().replace(/^\[|\]$/g, '');
    if (full.has(written)) return written;
    return byHandle.get(written.toLowerCase()) ?? undefined;
  };
}
