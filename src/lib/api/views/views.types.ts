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
  /**
   * Whether this node is the reader.
   *
   * The map always contains them, so the client needs to know which one they
   * are in order to draw it differently — and deriving that from `name` or from
   * a null `relationshipType` would be a guess that breaks the moment two people
   * share a name or a relationship goes unrecorded.
   */
  isSelf: boolean;
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
  /** How this person figures in it: protagonist, antagonist, supporting. */
  role: string;
  /** Null when never played. */
  lastPlayedAt: string | null;
  startable: boolean;
};

/**
 * One person, with the arcs they appear in — screens 10 and 11.
 *
 * Carries only what is recorded. There is no hook line, no bio and no second
 * label, because there is nothing behind them: the alternative to a sparse
 * screen is a model writing a sentence about a real person the reader knows.
 */
export type PersonDetailView = {
  id: string;
  name: string;
  isSelf: boolean;
  /** The structural fact only — "Roommates", "oldest friend". Null when unrecorded. */
  relationshipType: string | null;
  arcs: ArcView[];
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

/**
 * One conversation the reader handed over, and what became of it.
 *
 * Carries no message content and never can: the row behind it holds none
 * either, so this is not a view that drops fields for safety — the safety is in
 * the schema. `failure` is a code the client branches on, never a message: the
 * only text available at that point comes from the model or from an exception
 * wrapping the prompt, and the prompt is the transcript.
 */
export type ImportView = {
  id: string;
  conversationKey: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  /** Only set while running. Stages, not a percentage — extraction is one call. */
  stage: 'reading' | 'writing' | 'casting' | null;
  storylineId: string | null;
  failure: { code: string; retryable: boolean } | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionView = {
  id: string;
  storylineId: string;
  state: SessionStateView;
  turnsAnswered: number;
  turn: TurnView | null;
};
