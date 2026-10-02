import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';

// db.transaction has to run its callback for the service under test to do
// anything, so the fake just invokes it with a stand-in executor.
vi.mock('@/index', () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn({}) },
}));
vi.mock('./sessions.reader', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(),
  getOpenTurn: vi.fn(),
  getSessionIn: vi.fn(),
  getTurn: vi.fn(),
  nextTurnOrder: vi.fn(),
  findIdleSessions: vi.fn(),
  choiceBelongsToTurn: vi.fn(),
  turnIsUnanswered: vi.fn(),
  getTurnForUser: vi.fn(),
  countAnsweredTurns: vi.fn(),
  lastPlayedByStoryline: vi.fn(),
}));
vi.mock('./sessions.writer', () => ({
  insertSession: vi.fn(),
  insertTurn: vi.fn(),
  answerTurnGuarded: vi.fn(),
  touchSession: vi.fn(),
  advancePlayhead: vi.fn(),
  raisePlayheadTo: vi.fn(),
}));
vi.mock('../storylines/storylines.reader', () => ({ getStoryline: vi.fn() }));

const reader = vi.mocked(await import('./sessions.reader'));
const writer = vi.mocked(await import('./sessions.writer'));
const storylineReader = vi.mocked(await import('../storylines/storylines.reader'));
const service = await import('./sessions.service');

const USER = 'user-1';
const TURN = 'turn-1';
const CHOICE = 'choice-1';

beforeEach(() => vi.clearAllMocks());

describe('answerTurn', () => {
  const turn = {
    id: TURN,
    sessionId: 'session-1',
    turnOrder: 1,
    narrativeContent: 'x',
    headline: null,
    selectedChoiceId: CHOICE,
    respondedAt: new Date(),
    choices: [],
    surfaces: [],
  };

  it('touches the session after a successful answer', async () => {
    writer.answerTurnGuarded.mockResolvedValue({ id: TURN, sessionId: 'session-1' });
    reader.getTurn.mockResolvedValue(turn);

    await service.answerTurn(USER, TURN, CHOICE);

    expect(writer.touchSession).toHaveBeenCalledWith(expect.anything(), 'session-1');
  });

  /**
   * The third of the three writes that make up answering a turn
   * (invariants.md §5). Without it a playthrough's view of its own story never
   * moves: every later turn is generated against the same frozen history, and
   * the reader is stuck at the opening beat forever.
   */
  it('advances the playhead after a successful answer', async () => {
    writer.answerTurnGuarded.mockResolvedValue({ id: TURN, sessionId: 'session-1' });
    reader.getTurn.mockResolvedValue(turn);

    await service.answerTurn(USER, TURN, CHOICE);

    expect(writer.advancePlayhead).toHaveBeenCalledWith(expect.anything(), 'session-1');
  });

  it('does not advance the playhead when the answer was rejected', async () => {
    writer.answerTurnGuarded.mockResolvedValue(null);
    reader.turnIsUnanswered.mockResolvedValue(false);
    reader.getTurnForUser.mockResolvedValue({ ...turn, selectedChoiceId: 'a-different-choice' });

    await expect(service.answerTurn(USER, TURN, CHOICE)).rejects.toBeInstanceOf(ConflictError);
    expect(writer.advancePlayhead).not.toHaveBeenCalled();
  });

  // The guard covers four cases in one statement, so the reason is worked out
  // only after it has already failed. Each must map to a distinct error, or the
  // caller cannot tell "you already answered" from "that isn't your turn".
  describe('when the guarded update affects no rows', () => {
    beforeEach(() => writer.answerTurnGuarded.mockResolvedValue(null));

    it('reports an already-answered turn as a conflict', async () => {
      reader.turnIsUnanswered.mockResolvedValue(false);
      reader.getTurnForUser.mockResolvedValue({ ...turn, selectedChoiceId: 'a-different-choice' });

      await expect(service.answerTurn(USER, TURN, CHOICE)).rejects.toBeInstanceOf(ConflictError);
    });

    /**
     * The retry whose first response was lost. The client fires the next turn
     * the instant an answer lands, so this is a likely path rather than a rare
     * one — and a 409 here would strand a client on an operation that actually
     * succeeded, with nothing to distinguish it from one that did not.
     */
    it('returns the recorded turn when the same choice is answered twice', async () => {
      reader.turnIsUnanswered.mockResolvedValue(false);
      reader.getTurnForUser.mockResolvedValue(turn);

      await expect(service.answerTurn(USER, TURN, CHOICE)).resolves.toBe(turn);
      expect(writer.advancePlayhead).not.toHaveBeenCalled();
    });

    /**
     * `storyTurns` has no owner column — ownership runs through the session — so
     * reconciling against an unscoped read would answer "yes, that is already
     * your answer" about a stranger's turn.
     */
    it("does not reconcile against another user's answered turn", async () => {
      reader.turnIsUnanswered.mockResolvedValue(false);
      reader.getTurnForUser.mockResolvedValue(null);

      await expect(service.answerTurn(USER, TURN, CHOICE)).rejects.toBeInstanceOf(ConflictError);
    });

    it('reports a choice that was never offered as a validation failure', async () => {
      reader.turnIsUnanswered.mockResolvedValue(true);
      reader.choiceBelongsToTurn.mockResolvedValue(false);

      await expect(service.answerTurn(USER, TURN, CHOICE)).rejects.toBeInstanceOf(ValidationError);
    });

    // Unanswered and the choice is real, so the only remaining explanation is
    // that the session belongs to someone else. Reported as not-found rather
    // than forbidden, so it does not confirm the turn exists.
    it("reports another user's turn as not found", async () => {
      reader.turnIsUnanswered.mockResolvedValue(true);
      reader.choiceBelongsToTurn.mockResolvedValue(true);

      await expect(service.answerTurn(USER, TURN, CHOICE)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('never touches the session when the answer did not land', async () => {
      reader.turnIsUnanswered.mockResolvedValue(false);

      await expect(service.answerTurn(USER, TURN, CHOICE)).rejects.toThrow();
      expect(writer.touchSession).not.toHaveBeenCalled();
    });
  });
});

describe('startSession', () => {
  const ready = {
    id: 'story-1',
    title: 'x',
    sourceSurface: 'imessage',
    setting: null,
    tone: null,
    status: 'ready' as const,
    failureReason: null,
    arcSummary: null,
    arcSummaryGeneratedAt: null,
  };

  it.each(['pending', 'generating', 'failed'] as const)(
    'refuses to start a session on a %s storyline',
    async (status) => {
      storylineReader.getStoryline.mockResolvedValue({ ...ready, status });

      await expect(service.startSession(USER, 'story-1')).rejects.toBeInstanceOf(ValidationError);
      expect(writer.insertSession).not.toHaveBeenCalled();
    }
  );

  it('refuses a storyline the caller does not own', async () => {
    storylineReader.getStoryline.mockResolvedValue(null);

    await expect(service.startSession(USER, 'story-1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('openTurn', () => {
  it('returns the open turn without writing a new one', async () => {
    const open = {
      id: TURN,
      sessionId: 'session-1',
      turnOrder: 1,
      narrativeContent: 'already here',
      headline: null,
      selectedChoiceId: null,
      respondedAt: null,
      choices: [],
      surfaces: [],
    };
    reader.getSession.mockResolvedValue({
      id: 'session-1',
      storylineId: 'story-1',
      lastActiveAt: new Date(),
    });
    reader.getOpenTurn.mockResolvedValue(open);

    await expect(
      service.openTurn(USER, 'session-1', {
        headline: null,
        narrativeContent: 'new beat',
        choices: [{ label: 'x' }],
        surfaces: [],
      })
    ).resolves.toBe(open);
    expect(writer.insertTurn).not.toHaveBeenCalled();
  });
});
