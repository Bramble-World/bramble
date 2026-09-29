import { describe, expect, it } from 'vitest';
import type { PublicPerson } from '@/lib/services/persons/persons.types';
import type { PublicStoryline } from '@/lib/services/storylines/storylines.types';
import type { TurnWithChoices } from '@/lib/services/sessions/sessions.types';
import {
  arcView,
  personDetailView,
  personView,
  sessionView,
  storylineDetailView,
  turnView,
} from './index';

/**
 * Every fixture is deliberately loaded with the things that must not ship, so
 * a view that leaks has something to leak.
 */
const person: PublicPerson = {
  id: 'p1',
  name: 'Maya',
  isSelf: false,
  voiceProfile: {
    tone: 'clipped',
    quirks: ['changes the subject'],
    vocabulary: ['honestly'],
    sampleTurns: ['i really did think you knew'],
  },
};

const storyline: PublicStoryline = {
  id: 's1',
  title: 'The Unsent Apology',
  sourceSurface: 'imessage',
  setting: 'Two flats and a group chat, March to June.',
  tone: 'wistful',
  status: 'ready',
  failureReason: null,
  arcSummary: 'It began badly and ends with them reconciled on a rooftop.',
  arcSummaryGeneratedAt: new Date('2026-06-01T10:00:00.000Z'),
  createdAt: new Date('2026-03-01T10:00:00.000Z'),
};

const turn: TurnWithChoices = {
  id: 't1',
  sessionId: 'sess1',
  turnOrder: 3,
  narrativeContent: 'She answers before you have finished typing.',
  selectedChoiceId: null,
  respondedAt: null,
  choices: [
    {
      id: 'c1',
      turnId: 't1',
      label: 'Tell her the truth',
      description: 'It may not land.',
      orderIndex: 0,
    },
    { id: 'c2', turnId: 't1', label: 'Change the subject', description: null, orderIndex: 1 },
  ],
};

describe('views', () => {
  it('reduces a person to what a reader may see', () => {
    expect(personView(person)).toStrictEqual({ id: 'p1', name: 'Maya', isSelf: false });
  });

  it('renders a turn as narrative plus choices, and nothing else', () => {
    expect(turnView(turn)).toStrictEqual({
      id: 't1',
      narrative: 'She answers before you have finished typing.',
      choices: [
        { id: 'c1', label: 'Tell her the truth', description: 'It may not land.' },
        { id: 'c2', label: 'Change the subject', description: null },
      ],
    });
  });

  // Nullable, not empty-string — the turn schema's own words are "Null if the
  // label says enough". The Swift client models it as an optional.
  it('keeps a missing choice description as null', () => {
    expect(turnView(turn).choices[1].description).toBeNull();
  });

  it('carries setting as the premise and never the arc summary', () => {
    const view = arcView(storyline, 'protagonist', new Date('2026-06-02T09:00:00.000Z'));

    expect(view.setting).toBe('Two flats and a group chat, March to June.');
    expect(view.lastPlayedAt).toBe('2026-06-02T09:00:00.000Z');
    expect(view.startable).toBe(true);
  });

  it('marks a storyline that is not ready as unstartable', () => {
    expect(arcView({ ...storyline, status: 'generating' }).startable).toBe(false);
    expect(arcView({ ...storyline, status: 'failed' }).startable).toBe(false);
  });

  it('emits dates as ISO strings, never Date objects', () => {
    const view = arcView(storyline, 'protagonist', new Date('2026-06-02T09:00:00.000Z'));
    expect(typeof view.lastPlayedAt).toBe('string');
  });
  /**
   * Screens 10 and 11 from one payload. Everything here is recorded fact —
   * there is no hook line and no bio, because filling those would mean a model
   * writing a sentence about a real person the reader knows.
   */
  it('gives a person their relationship and their arcs, and nothing invented', () => {
    const view = personDetailView({
      person,
      relationshipType: 'oldest friend',
      arcs: [{ storyline, role: 'antagonist', lastPlayedAt: new Date('2026-06-02T09:00:00.000Z') }],
    });

    expect(view).toStrictEqual({
      id: 'p1',
      name: 'Maya',
      isSelf: false,
      relationshipType: 'oldest friend',
      arcs: [
        {
          storylineId: 's1',
          title: 'The Unsent Apology',
          setting: 'Two flats and a group chat, March to June.',
          tone: 'wistful',
          role: 'antagonist',
          lastPlayedAt: '2026-06-02T09:00:00.000Z',
          startable: true,
        },
      ],
    });
  });

  it('leaves a never-played arc null rather than dating it', () => {
    const view = personDetailView({
      person,
      relationshipType: null,
      arcs: [{ storyline, role: 'supporting', lastPlayedAt: null }],
    });

    expect(view.arcs[0].lastPlayedAt).toBeNull();
  });
});

/**
 * The test that keeps the layer honest.
 *
 * The exclusion list is not a paragraph people remember — it is this assertion.
 * It fails the moment someone writes `{...person}` instead of assigning fields,
 * and it keeps failing as new columns appear upstream, which is exactly when a
 * hand-maintained allowlist would silently stop covering them.
 *
 * `clerkId` is the sharpest of these: `PublicUser` carries it, and the only
 * thing stopping it shipping today is that one route hand-picks two fields.
 */
describe('nothing internal escapes any view', () => {
  const FORBIDDEN = [
    'clerkId',
    'userId',
    'sourceContactRef',
    'voiceProfile',
    'sampleTurns',
    'want',
    'avoids',
    'generationRationale',
    'stakes',
    'arcSummary',
    'failureReason',
    'playheadOrder',
    'narrativeOrder',
    'triggeredByTurnId',
    'orderIndex',
  ];

  const everyView = () => [
    personView(person),
    turnView(turn),
    arcView(storyline, 'supporting', new Date()),
    storylineDetailView(storyline, [person]),
    personDetailView({
      person,
      relationshipType: 'oldest friend',
      arcs: [{ storyline, role: 'antagonist', lastPlayedAt: new Date() }],
    }),
    sessionView({
      id: 'sess1',
      storylineId: 's1',
      state: 'awaiting_answer',
      turnsAnswered: 3,
      turn,
    }),
  ];

  it.each(FORBIDDEN)('never serialises %s', (key) => {
    const serialised = JSON.stringify(everyView());
    expect(serialised).not.toContain(key);
  });

  // The content, not just the key — a leak that renamed the field would still
  // be a leak.
  it.each([
    ['the arc summary', 'reconciled on a rooftop'],
    ['a voice sample', 'i really did think you knew'],
  ])('never serialises %s', (_label, content) => {
    expect(JSON.stringify(everyView())).not.toContain(content);
  });
});
