import { db } from '@/index';
import {
  ConflictError,
  InternalServerError,
  NotFoundError,
  ValidationError,
} from '@/lib/utils/errors';
import * as storylineReader from '../storylines/storylines.reader';
import * as timelineReader from '../timeline/timeline.reader';
import * as reader from './sessions.reader';
import * as writer from './sessions.writer';
import { Executor } from '../executor';
import { NewTurn, PublicSession, TurnWithChoices } from './sessions.types';

export const findIdleSessions = reader.findIdleSessions;
export const listSessions = reader.listSessions;

/**
 * Begins a playthrough, optionally at a beat the reader picked.
 *
 * `fromEventId` is what makes the world screen's "play from here" work: the
 * reader is shown twenty moments and starts a session at the one they chose.
 * The session's playhead lands **on** that beat, so the story continues from it —
 * the same relationship an ordinary new session has with the first beat.
 *
 * Starting a *new* session rather than moving an existing one is deliberate and
 * is what keeps `raisePlayheadTo` monotonic. A reader who picked an earlier beat
 * than they had reached would otherwise need the playhead walked backwards, and
 * that guard exists so a retried `generateConsequences` cannot do exactly that.
 * A fresh session has nowhere to walk back from.
 */
export async function startSession(
  userId: string,
  storylineId: string,
  fromEventId?: string
): Promise<PublicSession> {
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);
  if (storyline.status !== 'ready') {
    throw new ValidationError(`This storyline is not ready to play (status: ${storyline.status})`);
  }

  // Resolved against *this* storyline, which is what stops an event id from one
  // story positioning a session in another. The storyline was proved to be the
  // reader's above, so pairing the two is the whole of the ownership check.
  const startAt = fromEventId
    ? await timelineReader.narrativeOrderOf(storylineId, fromEventId)
    : null;
  if (fromEventId && startAt === null) throw new NotFoundError('Event', fromEventId);

  // One transaction, because a session inserted at playhead 0 is a session that
  // would render no history at all — the two writes are one fact.
  return db.transaction((tx) => insertSessionIn(tx, userId, storylineId, startAt, fromEventId));
}

/**
 * Creates a playthrough inside a caller's transaction.
 *
 * Split out so the find-or-create in `resumeOrStart` can hold one lock across
 * both the look-up and the insert. Two taps on the same moment would otherwise
 * both find nothing, both insert, and split the reader's progress across two
 * playthroughs of one beat.
 */
async function insertSessionIn(
  tx: Executor,
  userId: string,
  storylineId: string,
  startAt: number | null,
  fromEventId?: string
): Promise<PublicSession> {
  const session = await writer.insertSession(tx, userId, storylineId, fromEventId);

  if (startAt === null) {
    // Lands on the first beat: a new session has nothing above 0 but the
    // timeline itself, so the ordinary step does the initialising and there is
    // no separate first-run branch to keep in sync.
    await writer.advancePlayhead(tx, session.id);
  } else {
    // A raise rather than a set, and it is one here too: the session was just
    // created at 0, so every real beat is above it.
    await writer.raisePlayheadTo(tx, session.id, startAt);
  }

  const started = await reader.getSessionIn(tx, userId, session.id);
  if (!started) throw new NotFoundError('Session', session.id);
  return started;
}

/**
 * The playthrough a reader is currently in, if any.
 *
 * "Most recently created" is the rule the lab page already uses inline
 * (`allSessions.at(-1)`). Moving it here makes it one definition rather than a
 * convention each caller re-derives — and the API is about to be a second
 * caller, so the moment to do that is now.
 */
export async function currentSession(
  userId: string,
  storylineId: string
): Promise<PublicSession | null> {
  const sessions = await reader.listSessions(userId, storylineId);
  return sessions.at(-1) ?? null;
}

/**
 * Opens the storyline for play, resuming rather than restarting by default.
 *
 * A client that taps "start" twice — a double tap, a retried request, a screen
 * restored from the background — would otherwise get two playthroughs of the
 * same storyline, each with its own playhead, and the reader would silently lose
 * their place. Resuming is what almost every caller means.
 *
 * `mode: 'new'` keeps deliberate replays available, which is the other half of
 * what sessions are for.
 */
export async function resumeOrStart(
  userId: string,
  storylineId: string,
  mode: 'resume' | 'new' = 'resume',
  fromEventId?: string
): Promise<PublicSession> {
  if (!fromEventId) {
    if (mode === 'resume') {
      const existing = await currentSession(userId, storylineId);
      if (existing) return existing;
    }
    return startSession(userId, storylineId);
  }

  // Validated here rather than inside the transaction, so a bad id costs a read
  // instead of a lock. `startSession` re-checks on the create path.
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);
  if (storyline.status !== 'ready') {
    throw new ValidationError(`This storyline is not ready to play (status: ${storyline.status})`);
  }
  const startAt = await timelineReader.narrativeOrderOf(storylineId, fromEventId);
  if (startAt === null) throw new NotFoundError('Event', fromEventId);

  if (mode === 'new') {
    return db.transaction((tx) => insertSessionIn(tx, userId, storylineId, startAt, fromEventId));
  }

  // One playthrough per moment. The look-up and the insert share a transaction
  // and a lock, because without them two taps on the same moment both find
  // nothing, both insert, and the reader's progress is split across two
  // playthroughs of one beat with no way to merge them.
  return db.transaction(async (tx) => {
    await reader.lockStorylineForSessions(tx, storylineId);

    const existing = await reader.latestSessionFromEvent(tx, userId, storylineId, fromEventId);
    if (existing) return existing;

    return insertSessionIn(tx, userId, storylineId, startAt, fromEventId);
  });
}

export async function getSession(userId: string, sessionId: string): Promise<PublicSession> {
  const session = await reader.getSession(userId, sessionId);
  if (!session) throw new NotFoundError('Session', sessionId);
  return session;
}

export async function getOpenTurn(
  userId: string,
  sessionId: string
): Promise<TurnWithChoices | null> {
  await getSession(userId, sessionId);
  return reader.getOpenTurn(db, sessionId);
}

/**
 * Presents the next beat, or returns the one already awaiting an answer.
 *
 * Get-or-create rather than create, because a session has at most one open turn
 * (enforced since PR #23) and a retried or duplicated request should return the
 * decision the user is already looking at rather than fail. That matters most
 * for the caller this exists for: generating a turn costs a model call, and a
 * lost response must not produce a second one.
 *
 * The check and the write share a transaction so two concurrent callers cannot
 * both find nothing open and both insert; the loser hits the unique index.
 */
export async function openTurn(
  userId: string,
  sessionId: string,
  turn: NewTurn
): Promise<TurnWithChoices> {
  // A turn with nothing to choose is a dead end, and a dead end is what a
  // shipped client cannot recover from: a screen with no buttons and no next
  // request to make. `turnOutputSchema` already enforces `.min(2)` on the model,
  // so nothing on the live path reaches this — but an empty array was writable
  // through here, and the only reason it never shipped was that no client
  // existed to be killed by it.
  //
  // Zero, not `< 2`: one option is a degenerate turn but a renderable one, and
  // the minimum that makes a turn interesting belongs to the model's schema
  // rather than to the column's integrity.
  if (turn.choices.length === 0) {
    throw new ValidationError('A turn must offer at least one choice');
  }

  await getSession(userId, sessionId);

  return db.transaction(async (tx) => {
    const open = await reader.getOpenTurn(tx, sessionId);
    if (open) return open;

    const turnOrder = await reader.nextTurnOrder(tx, sessionId);
    const turnId = await writer.insertTurn(tx, sessionId, turnOrder, turn);
    // Read back rather than assembled here, so a fresh turn and a resumed one
    // are the same shape by construction — surfaces resolved, choices ordered.
    const written = await reader.getTurn(tx, turnId);
    if (!written)
      throw new InternalServerError(`Turn ${turnId} vanished inside its own transaction`);
    return written;
  });
}

/**
 * Records the user's decision.
 *
 * This is the fast, user-visible half of answering a turn. Everything it does is
 * one guarded UPDATE plus the session touch, both in one short transaction — no
 * model call happens here, because the user is waiting and because a failure
 * afterwards must not undo their answer.
 *
 * `lastActiveAt` is touched here and nowhere else. It means "the user answered",
 * not "something happened to this session".
 */
export async function answerTurn(
  userId: string,
  turnId: string,
  choiceId: string
): Promise<TurnWithChoices> {
  return db.transaction(async (tx) => {
    const answered = await writer.answerTurnGuarded(tx, userId, turnId, choiceId);

    if (!answered) {
      // The guard covers four cases in one statement, so the reason is worked
      // out only once it has already failed — off the happy path, where an extra
      // read costs nothing and a clear error is worth a lot.
      if (!(await reader.turnIsUnanswered(tx, turnId))) {
        // Self-reconciling: a retry of a request whose response was lost finds
        // its own answer already recorded. Failing that with a 409 would strand
        // a client on an operation that succeeded, with no way to tell the two
        // apart — and the retry is the likeliest caller, not the rarest, since
        // the client fires the next turn immediately after answering.
        //
        // Scoped read: `storyTurns` has no owner column, so an unscoped one here
        // would answer "yes, already answered" about a stranger's turn.
        const existing = await reader.getTurnForUser(tx, userId, turnId);
        if (existing?.selectedChoiceId === choiceId) return existing;
        throw new ConflictError('This turn has already been answered');
      }
      if (!(await reader.choiceBelongsToTurn(tx, turnId, choiceId))) {
        throw new ValidationError('That choice was not offered on this turn');
      }
      // Unanswered, the choice is real, so the session is not the caller's.
      throw new NotFoundError('Turn', turnId);
    }

    await writer.touchSession(tx, answered.sessionId);
    // Third write of the three that make up answering a turn (invariants.md §5).
    // The beat the reader has just lived through becomes history for the next
    // turn; skip it and the playthrough's view of its own story freezes.
    await writer.advancePlayhead(tx, answered.sessionId);

    const turn = await reader.getTurn(tx, turnId);
    if (!turn) throw new NotFoundError('Turn', turnId);
    return turn;
  });
}

/**
 * Where a playthrough is, and what to show — the resume probe.
 *
 * Three states with one remedy each, and no fourth. A client that died between
 * answering and having consequences written, one that died after, and a session
 * that has only just started are all `awaiting_turn`: the remedy is identical, so
 * telling them apart would give a shipped binary a branch to get wrong forever.
 *
 * Free and instant on purpose — no model call — so a client can call it on every
 * launch rather than guessing from local state.
 */
export async function sessionSnapshot(
  userId: string,
  sessionId: string
): Promise<{
  session: PublicSession;
  state: 'awaiting_answer' | 'awaiting_turn' | 'blocked';
  turnsAnswered: number;
  turn: TurnWithChoices | null;
  /**
   * Every turn already answered, oldest first.
   *
   * The reader is resuming a moment they opened days ago, so the screen has to
   * show them what they have already lived through rather than dropping them
   * into a narrative that refers to decisions they cannot see.
   */
  history: TurnWithChoices[];
}> {
  const session = await getSession(userId, sessionId);

  const [storyline, open, turnsAnswered, history] = await Promise.all([
    storylineReader.getStoryline(userId, session.storylineId),
    reader.getOpenTurn(db, sessionId),
    reader.countAnsweredTurns(db, sessionId),
    reader.listAnsweredTurns(db, sessionId),
  ]);

  // A storyline can fail after a session has begun, so this is a live check
  // rather than something settled at start. `blocked` still carries the open
  // turn if there is one — it is already the reader's to see, and hiding it
  // would blank a screen they were mid-way through.
  const state =
    !storyline || storyline.status !== 'ready'
      ? 'blocked'
      : open
        ? 'awaiting_answer'
        : 'awaiting_turn';

  return { session, state, turnsAnswered, turn: open, history };
}
