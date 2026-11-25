import type { NewTurnSurface, ResolvedSurface } from '@/lib/surfaces';

export type PublicSession = {
  id: string;
  storylineId: string;
  lastActiveAt: Date;
  /** The highest `events.narrativeOrder` this playthrough has reached. 0 = before everything. */
  playheadOrder: number;
  /** The beat this playthrough was opened at, or null when begun from the top. */
  startedFromEventId: string | null;
  /** When the story's ending was written. Null while it is still going. */
  endedAt: Date | null;
  /** Someone replies later: no next beat until then (pauses.ts). Null when nothing is owed. */
  replyDueAt: Date | null;
  /** That pause's kind (`soon`, `tonight`, `tomorrow`), set with `replyDueAt`. */
  replyDueKind: string | null;
};

export type PublicChoice = {
  id: string;
  turnId: string;
  label: string;
  description: string | null;
  /** The text the reader sends by picking it. Null for an action. */
  reply: string | null;
  orderIndex: number;
};

export type PublicTurn = {
  id: string;
  sessionId: string;
  turnOrder: number;
  narrativeContent: string;
  /** The one-sentence hook. Null on turns written before turns had one. */
  headline: string | null;
  /** The story's last beat: no choices, never answered. */
  isEnding: boolean;
  selectedChoiceId: string | null;
  respondedAt: Date | null;
  /** The reply to this beat's answer comes later (pauses.ts). Null for nearly every beat. */
  replyLater?: string | null;
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
  /** True for the story's last beat, which must offer no choices. */
  isEnding?: boolean;
  /** Written without spending energy (the first beat of a next story). */
  free?: boolean;
  /** The story pauses after this beat (pauses.ts). */
  replyLater?: 'soon' | 'tonight' | 'tomorrow';
  narrativeContent: string;
  choices: NewChoice[];
  surfaces: NewTurnSurface[];
};

/** Order is positional — the caller's array order becomes `orderIndex`. */
export type NewChoice = {
  label: string;
  description?: string;
  /** The text the reader sends by picking it. Absent for an action. */
  reply?: string;
};
