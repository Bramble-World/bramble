import { VoiceProfile } from '../persons/persons.types';

export type StorylineStatus = 'pending' | 'generating' | 'ready' | 'failed';
export type CharacterRole = 'protagonist' | 'antagonist' | 'supporting';
export type StorylineLinkType = 'sequel' | 'parallel' | 'crossover' | 'spinoff';

/** Closeness, tension, power balance — the shape both dynamic columns carry. */
export type Dynamic = {
  closeness?: string;
  tension?: string;
  powerBalance?: string;
};

export type PublicStoryline = {
  id: string;
  title: string;
  sourceSurface: string;
  setting: string | null;
  tone: string | null;
  status: StorylineStatus;
  failureReason: string | null;
  arcSummary: string | null;
  arcSummaryGeneratedAt: Date | null;
};

export type NewStoryline = {
  title: string;
  sourceSurface: string;
  setting?: string;
  tone?: string;
};

export type PublicCharacter = {
  id: string;
  storylineId: string;
  personId: string;
  role: CharacterRole;
  description: string | null;
  voiceProfileOverride: VoiceProfile | null;
};
