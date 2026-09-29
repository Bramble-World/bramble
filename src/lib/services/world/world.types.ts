/**
 * The map of people a reader's stories are made of.
 *
 * Nodes are **people**, never characters. A `characters` row is a per-storyline
 * casting of a person; keying the client's model of a human on it would make the
 * same person four different objects on one map.
 */

export type WorldNode = {
  personId: string;
  name: string;
  isSelf: boolean;
  /** The structural fact only — "Roommates", "siblings". Null when unrecorded. */
  relationshipType: string | null;
  /**
   * Extracted beats in this person's storylines that the reader has not reached.
   *
   * The literal reading of "bigger = more to explore", and the only candidate
   * that decays as you play. Storyline count barely varies; total beats would
   * leave a fully-explored person permanently the largest node.
   */
  unexploredBeats: number;
  storylineCount: number;
  /** Has the reader met them — appeared in a beat at or below the playhead. */
  met: boolean;
  lastActivityAt: Date | null;
};

export type WorldEdge = {
  aPersonId: string;
  bPersonId: string;
  relationshipType: string | null;
  /** How many of the reader's storylines both people are cast in. */
  sharedStorylines: number;
};

export type World = {
  nodes: WorldNode[];
  edges: WorldEdge[];
  /** True when the node cap bit. Honest rather than silently short. */
  truncated: boolean;
};

/**
 * Above this the map stops being a map.
 *
 * A real 45,000-message export held 440 threads. `MIN_THREAD_MESSAGES` prunes
 * most of them, so realistic counts are in the tens — but the cap costs nothing
 * and the failure without it is a payload nobody can draw.
 */
export const MAX_WORLD_NODES = 500;
