import type { NewTurnSurface, ResolvedSurface } from '@/lib/surfaces';

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
  /** The one-sentence hook. Null on turns written before turns had one. */
  headline: string | null;
  selectedChoiceId: string | null;
  respondedAt: Date | null;
};

/**
 * A turn always travels with its options; one without the other is not usable.
 * Its surfaces travel too, already resolved — empty for a text-only beat.
 */
export type TurnWithChoices = PublicTurn & {
  choices: PublicChoice[];
  surfaces: ResolvedSurface[];
};

/** Everything needed to open a turn. Surfaces are validated before they get here. */
export type NewTurn = {
  headline: string | null;
  narrativeContent: string;
  choices: NewChoice[];
  surfaces: NewTurnSurface[];
};

/** Order is positional — the caller's array order becomes `orderIndex`. */
export type NewChoice = {
  label: string;
  description?: string;
};
