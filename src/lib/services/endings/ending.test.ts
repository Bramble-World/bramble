import { describe, expect, it } from 'vitest';
import type { TurnWithChoices } from '../sessions/sessions.types';
import {
  ENDING_LEASE_MS,
  ENDING_MAX_ATTEMPTS,
  endingStatus,
  keyChoicesFor,
  mayAttemptEnding,
} from './ending.service';

/** An answered beat at `turnOrder`, its chosen option labelled `label`. */
const answered = (turnOrder: number, label: string): TurnWithChoices =>
  ({
    id: `t${turnOrder}`,
    sessionId: 's',
    turnOrder,
    headline: null,
    narrativeContent: 'A beat.',
    isEnding: false,
    selectedChoiceId: `c${turnOrder}`,
    createdAt: new Date(),
    choices: [
      {
        id: `c${turnOrder}`,
        turnId: `t${turnOrder}`,
        label,
        description: null,
        reply: null,
        orderIndex: 0,
      },
    ],
    surfaces: [],
  }) as unknown as TurnWithChoices;

/** Nine answered beats and the ending: beat N is turn order N. */
const turns = Array.from({ length: 9 }, (_, i) => answered(i + 1, `Choice ${i + 1}`));
const orders = [...turns.map((turn) => turn.turnOrder), 10];

describe('keyChoicesFor', () => {
  it('keeps the choices the model named that the reader made, in story order', () => {
    const { keyChoices, fellBack } = keyChoicesFor(
      [
        { beat: 7, label: 'you called her' },
        { beat: 2, label: 'you texted back' },
      ],
      orders,
      turns
    );

    expect(fellBack).toBe(false);
    expect(keyChoices).toEqual([
      { turnId: 't2', label: 'you texted back' },
      { turnId: 't7', label: 'you called her' },
    ]);
  });

  it('drops the ending, a beat that never happened and a repeat, but keeps the rest', () => {
    const { keyChoices, fellBack } = keyChoicesFor(
      [
        { beat: 10, label: 'you said goodbye' },
        { beat: 999, label: 'you did something that never happened' },
        { beat: 3, label: 'you went' },
        { beat: 3, label: 'you went again' },
      ],
      orders,
      turns
    );

    expect(fellBack).toBe(false);
    expect(keyChoices).toEqual([{ turnId: 't3', label: 'you went' }]);
  });

  it('falls back to three of the reader’s own choices, first to last, when none is real', () => {
    const { keyChoices, fellBack } = keyChoicesFor(
      [{ beat: 10, label: 'you said goodbye' }],
      orders,
      turns
    );

    expect(fellBack).toBe(true);
    expect(keyChoices).toEqual([
      { turnId: 't1', label: 'choice 1' },
      { turnId: 't5', label: 'choice 5' },
      { turnId: 't9', label: 'choice 9' },
    ]);
  });

  it('falls back to every choice when there are three or fewer', () => {
    const short = turns.slice(0, 2);
    const { keyChoices } = keyChoicesFor([], [1, 2, 3], short);

    expect(keyChoices.map((choice) => choice.turnId)).toEqual(['t1', 't2']);
  });
});

describe('the ending attempt lease', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ending = { title: 't', summary: 's', keyChoices: [], storyNights: null, peopleMet: [] };

  it('lets a first attempt start, and reports the ending as being written', () => {
    const record = { ending: null, attempts: 0, attemptedAt: null };

    expect(mayAttemptEnding(record, now)).toBe(true);
    expect(endingStatus(record, now)).toBe('writing');
  });

  it('holds off while an attempt is recent, and allows the next once its lease is up', () => {
    expect(mayAttemptEnding({ ending: null, attempts: 1, attemptedAt: ago(2_000) }, now)).toBe(
      false
    );
    expect(
      mayAttemptEnding({ ending: null, attempts: 1, attemptedAt: ago(ENDING_LEASE_MS + 1) }, now)
    ).toBe(true);
  });

  it('stops at the cap, and says so once the last attempt is over', () => {
    const last = { ending: null, attempts: ENDING_MAX_ATTEMPTS };

    expect(mayAttemptEnding({ ...last, attemptedAt: ago(ENDING_LEASE_MS + 1) }, now)).toBe(false);
    expect(endingStatus({ ...last, attemptedAt: ago(1_000) }, now)).toBe('writing');
    expect(endingStatus({ ...last, attemptedAt: ago(ENDING_LEASE_MS + 1) }, now)).toBe(
      'unavailable'
    );
  });

  it('never attempts a written ending', () => {
    const record = { ending, attempts: 1, attemptedAt: ago(ENDING_LEASE_MS * 10) };

    expect(mayAttemptEnding(record, now)).toBe(false);
    expect(endingStatus(record, now)).toBe('ready');
  });
});
