/**
 * What the client actually receives.
 *
 * Separate from the `Public*` types on purpose. Those are "public" relative to a
 * database row — they drop `userId` and a few join keys — and they were never a
 * response contract. Three of them carry something a client must not see:
 *
 * - `PublicUser.clerkId` is the identity-provider join key. The only thing
 *   stopping it shipping today is that `me/route.ts` hand-picks two fields.
 * - `PublicCharacter.want` / `.avoids` and `PublicEvent.stakes` are the levers
 *   the model writes the story with — literally what each person is after and
 *   what is at risk, which is most of every beat the reader has not reached.
 * - `PublicStoryline.arcSummary` describes the whole storyline, including beats
 *   above the playhead. The app has a playhead specifically to stop that
 *   reaching the model; serving it to the reader is the same leak on a screen.
 * - `PublicEvent.generationRationale` is the model explaining its own trick.
 *
 * None of that is caught by the type system today, which is why this layer
 * exists and why every field below is assigned explicitly. A spread is not a
 * view — it is a leak with a lid on it, and it reopens the moment a new column
 * is added upstream.
 *
 * Dates are `string`, always ISO. Note for the macOS client: `toISOString()`
 * always emits milliseconds, and Swift's `JSONDecoder.iso8601` strategy rejects
 * fractional seconds — it needs `[.withInternetDateTime, .withFractionalSeconds]`.
 */

/** A person as the map and the relationship screens show them. */
export type PersonView = {
  id: string;
  name: string;
  isSelf: boolean;
};

/** One node of the world map. */
export type WorldNodeView = {
  personId: string;
  name: string;
  /** The structural fact only — "Roommates", "siblings". Null when unrecorded. */
  relationshipType: string | null;
  /** 0..1, normalised across this user's own nodes. See `world.service`. */
  weight: number;
  /** The raw counts behind `weight`, so the client can change how it draws. */
  unexploredBeats: number;
  storylineCount: number;
  /** False until they appear in a beat the reader has reached. */
  met: boolean;
  lastActivityAt: string | null;
};

export type WorldEdgeView = {
  aPersonId: string;
  bPersonId: string;
  relationshipType: string | null;
  sharedStorylines: number;
};

/** One playable storyline, as it appears in a list against a person. */
export type ArcView = {
  storylineId: string;
  title: string;
  /** Place and period — never `arcSummary`, which gives away the ending. */
  setting: string | null;
  tone: string | null;
  /** Null when never played. */
  lastPlayedAt: string | null;
  startable: boolean;
};

export type StorylineDetailView = {
  id: string;
  title: string;
  setting: string | null;
  tone: string | null;
  startable: boolean;
  /** Only people the reader has met. */
  cast: PersonView[];
};

export type ChoiceView = {
  id: string;
  label: string;
  /** Null when the label says enough — the schema's own words. Optional in Swift. */
  description: string | null;
};

export type TurnView = {
  id: string;
  /** Screens 13 and 15 both render this. */
  narrative: string;
  choices: ChoiceView[];
};

/**
 * Where a playthrough is, as three states with one remedy each.
 *
 * A client that died between answering and having consequences written, one that
 * died after, and a brand-new session are all `awaiting_turn` — deliberately the
 * same, because the remedy is identical. Every state named here is a branch the
 * client carries forever, so a state with no distinct behaviour should not be
 * one.
 */
export type SessionStateView = 'awaiting_answer' | 'awaiting_turn' | 'blocked';

export type SessionView = {
  id: string;
  storylineId: string;
  state: SessionStateView;
  turnsAnswered: number;
  turn: TurnView | null;
};
