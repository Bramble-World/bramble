import { Dynamic } from '../storylines/storylines.types';

export type EventOrigin = 'extracted' | 'conversation_generated';
export type ContextSource = 'inferred' | 'conversation_generated' | 'user_provided';

export type PublicEvent = {
  id: string;
  storylineId: string;
  narrativeOrder: number;
  occurredAt: Date | null;
  title: string;
  description: string;
  stakes: string | null;
  /** 1-10, written by the model. Null when never scored — not when scored low. */
  engagementScore: number | null;
  origin: EventOrigin;
  triggeredByTurnId: string | null;
  generationRationale: string | null;
};

type EventFields = {
  title: string;
  description: string;
  stakes?: string;
  occurredAt?: Date;
  /** Characters present at this beat. Verified to belong to the storyline. */
  participantCharacterIds?: string[];
  /**
   * The one character who set this beat in motion, where a single person did.
   *
   * Distinct from being present, which is what `participantCharacterIds`
   * records. Stored for measurement; no prompt reads it.
   */
  actorCharacterId?: string;
  /**
   * How much this beat invites being played from, 1-10.
   *
   * Optional, because `appendEvent` is reachable from tests and scripts that have
   * no model behind them. Absent means the beat is simply not rankable, which the
   * ranked read handles by excluding it rather than by scoring it zero.
   */
  engagementScore?: number;
};

/**
 * A new beat, discriminated on `origin`.
 *
 * invariants.md §4 requires `triggeredByTurnId` to be set when `origin` is
 * `conversation_generated` and null when it is `extracted`, and nothing in the
 * database ties them — a generated beat with no lineage reads as valid, and it
 * is the only record of why that beat exists at all.
 *
 * Expressing it as a union makes the wrong combination unrepresentable rather
 * than merely documented. `generationRationale` is required on the same branch
 * for the same reason: a steered beat that cannot say why it was added is not
 * traceable, which is the entire point of the origin column.
 */
export type NewEvent =
  | ({ origin: 'extracted' } & EventFields)
  | ({
      origin: 'conversation_generated';
      triggeredByTurnId: string;
      generationRationale: string;
    } & EventFields);

/** Same treatment for `contextEntries.triggeredByTurnId` (invariants.md §4). */
export type NewContextEntry =
  | {
      source: 'inferred' | 'user_provided';
      content: string;
      characterId?: string;
    }
  | {
      source: 'conversation_generated';
      triggeredByTurnId: string;
      content: string;
      characterId?: string;
    };

export type PublicContextEntry = {
  id: string;
  storylineId: string;
  characterId: string | null;
  content: string;
  source: ContextSource;
  triggeredByTurnId: string | null;
};

export type NewRelationshipState = {
  relationshipId: string;
  eventId: string;
  dynamic: Dynamic;
};
