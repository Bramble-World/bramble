import * as reader from './world.reader';
import { MAX_WORLD_NODES, World, WorldEdge, WorldNode } from './world.types';

/**
 * The reader's world: who is in their stories, and how much of each is left.
 *
 * Nodes are people, never characters — a `characters` row is one storyline's
 * casting of a person, and keying the client's model of a human on it would put
 * the same person on the map four times.
 *
 * Returns empty arrays for a reader with no data. **Never a 404** — "you have no
 * world yet" is a screen the designs call for (screen 20), not an error, and a
 * 404 would make the client render a failure where it should render an
 * invitation.
 */
export async function getWorld(userId: string): Promise<World> {
  const [people, exploration, edges] = await Promise.all([
    reader.peopleFor(userId),
    reader.explorationFor(userId),
    reader.edgesFor(userId),
  ]);

  const byPerson = new Map(exploration.map((row) => [row.personId, row]));

  const nodes: WorldNode[] = people.map((person) => {
    const stats = byPerson.get(person.personId);
    return {
      personId: person.personId,
      name: person.name,
      isSelf: person.isSelf,
      relationshipType: person.relationshipType,
      unexploredBeats: stats?.unexploredBeats ?? 0,
      storylineCount: stats?.storylineCount ?? 0,
      // The reader is present at their own story whatever the beats record.
      met: person.isSelf || (stats?.met ?? false),
      lastActivityAt: stats?.lastActivityAt ?? null,
    };
  });

  // Deterministic, so "some of the people in your story" (screen 06) is the same
  // set across relaunches rather than whatever the database felt like returning.
  nodes.sort((a, b) => b.unexploredBeats - a.unexploredBeats || a.name.localeCompare(b.name));

  const kept = nodes.slice(0, MAX_WORLD_NODES);
  const keptIds = new Set(kept.map((n) => n.personId));

  return {
    nodes: kept,
    // An edge to someone who was cut is an edge to nothing. Dropping it here
    // means the client never has to defend against a dangling endpoint.
    edges: edges
      .filter((e) => keptIds.has(e.aPersonId) && keptIds.has(e.bPersonId))
      .map(
        (e): WorldEdge => ({
          aPersonId: e.aPersonId,
          bPersonId: e.bPersonId,
          relationshipType: e.relationshipType,
          sharedStorylines: 0,
        })
      ),
    truncated: nodes.length > kept.length,
  };
}

/**
 * Normalises unexplored counts to 0..1 for drawing.
 *
 * Per reader, not globally: a reader with one imported thread should still get a
 * legible map rather than a field of identical dots, and there is no meaningful
 * cross-user scale to normalise against anyway.
 *
 * Kept separate from `getWorld` and exported so the raw counts travel alongside
 * it. The visual mapping is the thing most likely to be wrong on first contact
 * with a real design, and sending both means changing it costs a client release
 * rather than a server one.
 */
export function weightsFor(nodes: WorldNode[]): Map<string, number> {
  const highest = Math.max(0, ...nodes.map((n) => n.unexploredBeats));
  return new Map(nodes.map((n) => [n.personId, highest === 0 ? 0 : n.unexploredBeats / highest]));
}
