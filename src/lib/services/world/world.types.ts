/**
 * The moments a reader can start playing from.
 *
 * "World" used to mean the graph of people a reader's stories are made of. It now
 * means what there is to play: the beats the model judged most worth opening on,
 * across every storyline the reader owns. The people graph was retired when the
 * client stopped drawing it — recover it from git history (PRs #49, #52, #53)
 * rather than rewriting it, since `explorationFor` held the only SQL expression
 * of the playhead's "met" rule.
 *
 * Beats, not storylines: three imported conversations produce hundreds of beats,
 * and the point of the score is that twenty of them are worth drawing.
 */

export type WorldEventPerson = {
  id: string;
  name: string;
  isSelf: boolean;
};

export type WorldEvent = {
  /** What the client starts a session from. The narrative order never ships. */
  eventId: string;
  storylineId: string;
  /** So twenty titles are not twenty orphans with no story to belong to. */
  storylineTitle: string;
  title: string;
  /** What happened, retold. Never an excerpt — see invariants.md §1. */
  description: string;
  occurredAt: Date | null;
  /**
   * Who was there, as people rather than characters.
   *
   * A `characters` row is one storyline's casting of a person, so keying the
   * client's model of a human on it would make the same person several objects
   * across one screen — the reader would see "Maya" three times and have no way
   * to know it was one Maya. The card shows names, so it gets people.
   */
  people: WorldEventPerson[];
  /**
   * 1-10, as the model wrote it.
   *
   * Travels alongside the normalised weight rather than instead of it, so the
   * client can change how engagement is drawn without a server release.
   */
  score: number;
};

export type World = {
  events: WorldEvent[];
  /** True when the cap bit. Honest rather than silently short. */
  truncated: boolean;
};

/**
 * How many moments the reader is offered at once.
 *
 * The number exists because of what it prevents, not because twenty is special:
 * three conversations extract up to twenty beats each and then accumulate a
 * generated beat per decision, so an uncapped list is hundreds of rows and a
 * screen nobody can choose from. Twenty is enough to fill a surface and few
 * enough to read.
 */
export const MAX_WORLD_EVENTS = 20;
