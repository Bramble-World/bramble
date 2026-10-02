import { describe, expect, it } from 'vitest';
import type { PublicPerson } from '@/lib/services/persons/persons.types';
import type { PublicStoryline } from '@/lib/services/storylines/storylines.types';
import type { TurnWithChoices } from '@/lib/services/sessions/sessions.types';
import {
  answeredTurnView,
  arcView,
  personDetailView,
  personView,
  sessionView,
  storylineDetailView,
  turnView,
  worldEventView,
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
  headline: null,
  selectedChoiceId: null,
  respondedAt: null,
  surfaces: [],
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

/** A beat that plays out on the phone. Its texts avoid every FORBIDDEN word. */
const phoneTurn: TurnWithChoices = {
  ...turn,
  id: 't2',
  headline: 'Maya just texted you at 1:47.',
  narrativeContent: 'You read it with the sound off.',
  surfaces: [
    {
      type: 'imessage_notifications',
      clockTime: '1:47',
      dateLabel: 'Saturday, June 14',
      notifications: [
        { sender: { id: 'p1', name: 'Maya', isSelf: false }, text: 'are you awake' },
        { sender: { id: 'p1', name: 'Maya', isSelf: false }, text: 'i saw the photos' },
      ],
    },
  ],
};

const worldEvent = {
  eventId: 'e1',
  storylineId: 's1',
  storylineTitle: 'The Unsent Apology',
  title: 'The apology that landed wrong',
  description: 'An apology was offered and waved away before it finished.',
  occurredAt: new Date('2026-04-02T18:00:00.000Z'),
  people: [
    { id: 'p0', name: 'Blossom', isSelf: true },
    { id: 'p1', name: 'Maya', isSelf: false },
  ],
  score: 9,
  playthrough: null,
};

describe('views', () => {
  it('reduces a person to what a reader may see', () => {
    expect(personView(person)).toStrictEqual({ id: 'p1', name: 'Maya', isSelf: false });
  });

  it('renders a turn as headline, narrative, choices and surfaces, and nothing else', () => {
    expect(turnView(turn)).toStrictEqual({
      id: 't1',
      headline: null,
      narrative: 'She answers before you have finished typing.',
      choices: [
        { id: 'c1', label: 'Tell her the truth', description: 'It may not land.' },
        { id: 'c2', label: 'Change the subject', description: null },
      ],
      surfaces: [],
    });
  });

  it('renders a surface as its type and fields — no version, no character ids', () => {
    expect(turnView(phoneTurn).surfaces).toStrictEqual([
      {
        type: 'imessage_notifications',
        clockTime: '1:47',
        dateLabel: 'Saturday, June 14',
        notifications: [
          { sender: { id: 'p1', name: 'Maya', isSelf: false }, text: 'are you awake' },
          { sender: { id: 'p1', name: 'Maya', isSelf: false }, text: 'i saw the photos' },
        ],
      },
    ]);
    expect(turnView(phoneTurn).headline).toBe('Maya just texted you at 1:47.');
  });

  // Nullable, not empty-string — the turn schema's own words are "Null if the
  // label says enough". The Swift client models it as an optional.
  /**
   * The list names beats the reader has not reached, on purpose — that is what
   * makes "play from here" possible. What it must not carry is the machinery the
   * story is written with.
   */
  it('offers a moment by its title, its score and nothing else', () => {
    expect(worldEventView(worldEvent, 1)).toStrictEqual({
      eventId: 'e1',
      storylineId: 's1',
      storylineTitle: 'The Unsent Apology',
      title: 'The apology that landed wrong',
      description: 'An apology was offered and waved away before it finished.',
      occurredAt: '2026-04-02T18:00:00.000Z',
      people: [
        { id: 'p0', name: 'Blossom', isSelf: true },
        { id: 'p1', name: 'Maya', isSelf: false },
      ],
      score: 9,
      weight: 1,
      playthrough: null,
    });
  });

  // The card shows names, and the reader reads differently from everyone else.
  it('carries who was there, reader first', () => {
    const view = worldEventView(worldEvent, 1);

    expect(view.people.map((p) => p.name)).toStrictEqual(['Blossom', 'Maya']);
    expect(view.people[0].isSelf).toBe(true);
  });

  it('carries a beat nobody was recorded at as an empty cast, not a missing one', () => {
    expect(worldEventView({ ...worldEvent, people: [] }, 1).people).toStrictEqual([]);
  });

  it('keeps an undated moment null rather than inventing a date', () => {
    expect(worldEventView({ ...worldEvent, occurredAt: null }, 0.5).occurredAt).toBeNull();
  });

  // What turns "play" into "continue" on the card.
  it('carries a playthrough when one was opened at this moment', () => {
    const view = worldEventView(
      {
        ...worldEvent,
        playthrough: {
          sessionId: 'sess1',
          turnsAnswered: 4,
          lastActiveAt: new Date('2026-05-01T09:30:00.000Z'),
        },
      },
      1
    );

    expect(view.playthrough).toStrictEqual({
      sessionId: 'sess1',
      turnsAnswered: 4,
      lastActiveAt: '2026-05-01T09:30:00.000Z',
    });
  });

  /**
   * Always present, never absent. A client branching on a missing key behaves
   * differently from one branching on null, and only one of those is testable.
   */
  it('says null rather than omitting an unplayed moment', () => {
    expect(worldEventView(worldEvent, 1)).toHaveProperty('playthrough', null);
  });

  it('renders an answered turn with the decision that closed it', () => {
    const answered = { ...turn, selectedChoiceId: 'c1' };

    expect(answeredTurnView(answered)).toStrictEqual({
      turn: turnView(answered),
      chosenChoiceId: 'c1',
    });
  });

  /**
   * A reader resuming a moment opened days ago needs to see what they already
   * decided — without it the narrative refers to choices they cannot see.
   */
  it('carries history oldest first, and [] when nothing is answered', () => {
    const first = { ...turn, id: 't1', turnOrder: 1, selectedChoiceId: 'c1' };
    const second = { ...turn, id: 't2', turnOrder: 2, selectedChoiceId: 'c2' };

    const view = sessionView({
      id: 'sess1',
      storylineId: 's1',
      state: 'awaiting_answer',
      turnsAnswered: 2,
      turn,
      history: [first, second],
    });

    expect(view.history.map((h) => h.turn.id)).toStrictEqual(['t1', 't2']);
    expect(view.history.map((h) => h.chosenChoiceId)).toStrictEqual(['c1', 'c2']);
    expect(
      sessionView({
        id: 'sess1',
        storylineId: 's1',
        state: 'awaiting_turn',
        turnsAnswered: 0,
        turn: null,
        history: [],
      }).history
    ).toStrictEqual([]);
  });

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
    turnView(phoneTurn),
    arcView(storyline, 'supporting', new Date()),
    storylineDetailView(storyline, [person]),
    worldEventView(worldEvent, 1),
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
      history: [],
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
