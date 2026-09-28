export type PublicSession = {
  id: string;
  storylineId: string;
  lastActiveAt: Date;
  /** The highest `events.narrativeOrder` this playthrough has reached. 0 = before everything. */
  playheadOrder: number;
};

export type PublicChoice = {
  id: string;
  turnId: string;
  label: string;
  description: string | null;
  orderIndex: number;
};

export type PublicTurn = {
  id: string;
  sessionId: string;
  turnOrder: number;
  narrativeContent: string;
  selectedChoiceId: string | null;
  respondedAt: Date | null;
};

/** A turn always travels with its options; one without the other is not usable. */
export type TurnWithChoices = PublicTurn & { choices: PublicChoice[] };

/** Order is positional — the caller's array order becomes `orderIndex`. */
export type NewChoice = {
  label: string;
  description?: string;
};
