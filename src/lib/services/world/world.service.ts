import * as reader from './world.reader';
import { MAX_WORLD_EVENTS, World, WorldEvent } from './world.types';

/**
 * The moments a reader can start playing from, best first.
 *
 * Returns empty for a reader with nothing. **Never a 404** — "you have no world
 * yet" is a screen the designs call for, not an error, and a 404 would make the
 * client render a failure where it should render an invitation. That was true when
 * this returned a graph of people and it is true now.
 *
 * No ownership argument to make here: every row comes back from a query anchored
 * on `storylines.userId`, and no identifier in the result ever arrived in a
 * request.
 */
export async function getWorld(userId: string, limit: number = MAX_WORLD_EVENTS): Promise<World> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), MAX_WORLD_EVENTS);

  const [events, rankable] = await Promise.all([
    reader.topEventsFor(userId, capped),
    reader.countRankableFor(userId),
  ]);

  return { events, truncated: rankable > events.length };
}

/**
 * Normalises scores to 0..1 for drawing.
 *
 * Per reader and per response, not against the 1-10 scale, and that is the point:
 * a reader whose best beat scored a 6 should still get a legible spread rather
 * than twenty muted dots, because the client is signalling *relative* interest
 * within one screen.
 *
 * Kept out of `getWorld` and exported separately so the raw scores travel
 * alongside it. The visual mapping is the thing most likely to be wrong on first
 * contact with a real design, and sending both means changing it costs a client
 * release rather than a server one.
 */
export function weightsFor(events: WorldEvent[]): Map<string, number> {
  const highest = Math.max(0, ...events.map((event) => event.score));
  return new Map(events.map((event) => [event.eventId, highest === 0 ? 0 : event.score / highest]));
}
