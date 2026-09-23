import { db } from '@/index';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import * as storylineReader from '../storylines/storylines.reader';
import * as reader from './sessions.reader';
import * as writer from './sessions.writer';
import { NewChoice, PublicSession, TurnWithChoices } from './sessions.types';

export const findIdleSessions = reader.findIdleSessions;
export const listSessions = reader.listSessions;

export async function startSession(userId: string, storylineId: string): Promise<PublicSession> {
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);
  if (storyline.status !== 'ready') {
    throw new ValidationError(`This storyline is not ready to play (status: ${storyline.status})`);
  }

  return writer.insertSession(db, userId, storylineId);
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
  narrativeContent: string,
  choices: NewChoice[]
): Promise<TurnWithChoices> {
  await getSession(userId, sessionId);

  return db.transaction(async (tx) => {
    const open = await reader.getOpenTurn(tx, sessionId);
    if (open) return open;

    const turnOrder = await reader.nextTurnOrder(tx, sessionId);
    return writer.insertTurnWithChoices(tx, sessionId, turnOrder, narrativeContent, choices);
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
        throw new ConflictError('This turn has already been answered');
      }
      if (!(await reader.choiceBelongsToTurn(tx, turnId, choiceId))) {
        throw new ValidationError('That choice was not offered on this turn');
      }
      // Unanswered, the choice is real, so the session is not the caller's.
      throw new NotFoundError('Turn', turnId);
    }

    await writer.touchSession(tx, answered.sessionId);

    const turn = await reader.getTurn(tx, turnId);
    if (!turn) throw new NotFoundError('Turn', turnId);
    return turn;
  });
}
