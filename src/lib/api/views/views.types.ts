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

/**
 * One moment the reader can start playing from.
 *
 * The map of people this replaced showed no beats at all, which is why it needed
 * no judgement about spoilers. This does: the list is mostly beats the reader has
 * not reached, and naming them is the feature — you cannot offer "play from here"
 * without saying where "here" is.
 *
 * What it still must not carry is the machinery. `stakes` is the lever the model
 * writes with, literally what is at risk; `generationRationale` is the model
 * explaining its own trick; `narrativeOrder` is an internal key, and the client
 * starts a session from `eventId` so it never needs one.
 */
export type WorldEventView = {
  eventId: string;
  storylineId: string;
  /** So twenty titles are not twenty orphans with no story to belong to. */
  storylineTitle: string;
  title: string;
  /** What happened, retold. Never an excerpt of a message. */
  description: string;
  /** When it happened, if the conversation said. ISO, or null. */
  occurredAt: string | null;
  /** Who was there. People, never per-storyline characters. Reader first. */
  people: PersonView[];
  /** 1-10, as the model wrote it. */
  score: number;
  /** 0..1, normalised across this response. See `world.service`. */
  weight: number;
  /**
   * The reader's latest playthrough opened at this beat, if there is one.
   *
   * What turns "play" into "continue" on the card. Always present — `null` when
   * they have never started here — so the client branches on a value rather than
   * on a missing key.
   */
  playthrough: { sessionId: string; turnsAnswered: number; lastActiveAt: string } | null;
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

/** One turn the reader has already answered, and what they picked. */
export type AnsweredTurnView = {
  turn: TurnView;
  /**
   * Null only if the choice row was deleted out from under the turn —
   * `selected_choice_id` is `on delete set null`. Answered turns otherwise
   * always have one.
   */
  chosenChoiceId: string | null;
};

export type SessionView = {
  id: string;
  storylineId: string;
  state: SessionStateView;
  turnsAnswered: number;
  turn: TurnView | null;
  /**
   * Everything already lived through, oldest first, excluding the open turn.
   *
   * A reader resuming a moment opened days ago needs to see the decisions they
   * have already made — without them the narrative refers to things they cannot
   * remember taking. Always present: `[]` for a session that has answered
   * nothing.
   */
  history: AnsweredTurnView[];
};
