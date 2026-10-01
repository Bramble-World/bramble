import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { getWorld, weightsFor } from '@/lib/services/world/world.service';
import { MAX_WORLD_EVENTS } from '@/lib/services/world/world.types';
import { worldEventView } from '@/lib/api/views';
import type { WorldEventView } from '@/lib/api/views';

/**
 * The moments the reader can start playing from, best first.
 *
 * Twenty beats across every storyline they own, ranked by how much the model
 * thought each one invites being opened on. Tapping one starts a new session
 * positioned there, which is why `eventId` ships and `narrativeOrder` does not.
 *
 * This is a discovery surface, not a highlights reel: most of these are beats the
 * reader has not reached, and that is deliberate. `contextAsOf` still stops the
 * *model* reading ahead; what changed is that the reader is now shown unplayed
 * beats on purpose, because a scene-select cannot work otherwise. The machinery
 * stays hidden — no `stakes`, no `generationRationale`.
 *
 * Both the normalised `weight` and the raw `score` are returned. The visual
 * mapping is the thing most likely to be wrong on first contact with a real
 * design, and sending both means changing it costs a client release rather than a
 * server one.
 *
 * No ownership check on any id, because no id arrived in a request — every row
 * here was produced under a `storylines.userId` predicate.
 */
export const GET = withUser(async (user, request) => {
  // Clamped rather than trusted: this is a public endpoint, and an unbounded
  // limit is a payload nobody can draw and a query nobody asked for.
  const requested = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isFinite(requested) && requested > 0 ? requested : MAX_WORLD_EVENTS;

  const world = await getWorld(user.id, limit);
  const weights = weightsFor(world.events);

  const events: WorldEventView[] = world.events.map((event) =>
    worldEventView(event, weights.get(event.eventId) ?? 0)
  );

  // An object, never a bare array: `truncated` could not have been added later to
  // a top-level array without breaking a shipped decoder.
  return json({ events, truncated: world.truncated });
});
