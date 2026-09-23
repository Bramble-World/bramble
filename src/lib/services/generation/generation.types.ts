import { Dynamic } from '../storylines/storylines.types';
import { VoiceProfile } from '../persons/persons.types';

/**
 * Everything a prompt needs to know about a storyline.
 *
 * Three properties are deliberate and worth keeping:
 *
 * 1. **Fully JSON-serialisable.** No drizzle row types, no `Date`s. That lets a
 *    fixture be checked in and compared, and keeps prompt renderers pure.
 * 2. **Derived values are resolved here, once.** Effective voice, current
 *    dynamic, participant ids. Re-deriving them in each prompt is how four
 *    prompts end up disagreeing about what "current" means.
 * 3. **It structurally cannot leak raw messages.** Everything in it came out of
 *    a database that never holds any, which is a real invariants.md §1 property
 *    rather than a convention to remember.
 */
export type StorylineContext = {
  storyline: {
    id: string;
    title: string;
    setting: string | null;
    tone: string | null;
    arcSummary: string | null;
  };
  characters: CharacterContext[];
  relationships: RelationshipContext[];
  timeline: BeatContext[];
  /** Backstory the story implies but never states. */
  background: {
    storylineLevel: string[];
    byCharacterId: Record<string, string[]>;
  };
  motifs: MotifContext[];
};

export type CharacterContext = {
  id: string;
  personId: string;
  name: string;
  role: 'protagonist' | 'antagonist' | 'supporting';
  description: string | null;
  /** `voiceProfileOverride` when this story deviates, else the person's own. */
  voice: VoiceProfile | null;
  isSelf: boolean;
};

export type RelationshipContext = {
  id: string;
  characterAId: string;
  characterBId: string;
  /** The persistent, structural fact — "siblings" — from personRelationships. */
  relationshipType: string | null;
  /** How things stood at the story's outset. */
  baselineDynamic: Dynamic | null;
  /** The latest state, by the narrative order of the event that caused it. */
  currentDynamic: Dynamic | null;
};

export type BeatContext = {
  id: string;
  narrativeOrder: number;
  title: string;
  description: string;
  stakes: string | null;
  origin: 'extracted' | 'conversation_generated';
  occurredAt: string | null;
  participantCharacterIds: string[];
};

export type MotifContext = {
  id: string;
  label: string;
  description: string | null;
  personIds: string[];
};

/** The decision loop so far, for a prompt that must not repeat itself. */
export type SessionContext = {
  sessionId: string;
  storylineId: string;
  turns: Array<{
    turnOrder: number;
    narrativeContent: string;
    /** What was offered, and which was taken. Null while awaiting an answer. */
    choices: Array<{ id: string; label: string; description: string | null }>;
    selectedChoiceLabel: string | null;
  }>;
};

/**
 * What extraction has to work with, which is deliberately not a StorylineContext.
 *
 * Extraction has no storyline yet — that is the thing it produces — so forcing
 * it through the same shape would mean an optional-everything type that pretends
 * two genuinely different inputs are the same. What it needs instead is who the
 * user already knows, so a person who appears in a second transcript is matched
 * to the row that already exists rather than duplicated.
 */
export type UserContext = {
  userId: string;
  self: { id: string; name: string } | null;
  persons: Array<{ id: string; name: string; voice: VoiceProfile | null }>;
  motifs: Array<{ id: string; label: string; description: string | null }>;
};
