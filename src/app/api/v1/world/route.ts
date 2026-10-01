import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { getWorld, weightsFor } from '@/lib/services/world/world.service';
import type { WorldEdgeView, WorldNodeView } from '@/lib/api/views';

/**
 * The map of people the reader's stories are made of — screens 06, 08, 09, 17.
 *
 * One request serves all four. Screen 09 (tapping a node) is rendered from this
 * payload rather than a second round trip: a tap on a map must not wait on the
 * network, and everything it shows is already here.
 *
 * Both the normalised `weight` and the raw counts it came from are returned. The
 * visual mapping is the thing most likely to be wrong on first contact with a
 * real design, and sending both means changing it costs a client release rather
 * than a server one.
 *
 * No ownership check on any id, because no id arrived in a request — every row
 * here was produced under a `userId` predicate.
 */
export const GET = withUser(async (user) => {
  const world = await getWorld(user.id);
  const weights = weightsFor(world.nodes);

  const nodes: WorldNodeView[] = world.nodes.map((node) => ({
    personId: node.personId,
    name: node.name,
    isSelf: node.isSelf,
    relationshipType: node.relationshipType,
    weight: weights.get(node.personId) ?? 0,
    unexploredBeats: node.unexploredBeats,
    storylineCount: node.storylineCount,
    met: node.met,
    lastActivityAt: node.lastActivityAt?.toISOString() ?? null,
  }));

  const edges: WorldEdgeView[] = world.edges.map((edge) => ({
    aPersonId: edge.aPersonId,
    bPersonId: edge.bPersonId,
    relationshipType: edge.relationshipType,
    sharedStorylines: edge.sharedStorylines,
  }));

  // An object, never a bare array: `truncated` could not have been added later
  // to a top-level array without breaking a shipped decoder.
  return json({ nodes, edges, truncated: world.truncated });
});
