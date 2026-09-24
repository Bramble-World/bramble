'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, NotFoundError, ValidationError } from '@/lib/utils/errors';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import * as sessions from '@/lib/services/sessions/sessions.service';
import * as storylineWriter from '@/lib/services/storylines/storylines.writer';
import {
  commitChoice,
  generateConsequences,
  generateTurn,
} from '@/lib/services/generation/turns.service';
import { extractStoryline } from '@/lib/services/generation/extraction.service';
import { sweepIdleSessions } from '@/lib/services/generation/arc.service';
import { threeWeeksLater, unsentApology } from '@/lib/services/generation/__fixtures__/transcripts';
import { MAX_TRANSCRIPT_CHARS } from '@/lib/services/generation/limits';

/**
 * Server actions for the harness.
 *
 * Each one authenticates and validates its own input rather than trusting the
 * page that rendered the form. Per Next.js's Server Actions guide, an action is
 * a POST endpoint against the page and is reachable by anyone who can send the
 * request — render-time gating is not a security boundary. That the caller here
 * is always a dev-only resolver does not change the shape the code should have.
 *
 * Return values are narrow: a message and whatever the page needs, never a row.
 * Action returns are serialised to the client, and the same guide is explicit
 * that they should be shaped to what the UI renders.
 */
export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const uuid = z.string().uuid();

/** Domain errors carry a message worth showing; anything else does not. */
async function run(work: () => Promise<string>): Promise<ActionResult> {
  try {
    return { ok: true, message: await work() };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, message: error.message };
    console.error(error);
    return { ok: false, message: 'Something went wrong. Check the server log.' };
  }
}

export async function startSessionAction(storylineId: string): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();
    const id = uuid.parse(storylineId);
    const session = await sessions.startSession(user.id, id);
    revalidatePath(`/lab/${id}`);
    return `Started session ${session.id.slice(0, 8)}`;
  });
}

export async function generateTurnAction(sessionId: string): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();
    const id = uuid.parse(sessionId);
    const session = await sessions.getSession(user.id, id);
    const turn = await generateTurn(user.id, id);
    revalidatePath(`/lab/${session.storylineId}`);
    return `Turn ${turn.turnOrder} ready`;
  });
}

/**
 * Answer, then work out what it changed.
 *
 * Two calls rather than one, and in this order, because that is what the
 * services enforce: the answer is recorded in its own short transaction before
 * any model call, so a generation failure afterwards cannot lose the decision.
 * If the second half fails the page still reflects the answer, and the turn is
 * left in the resumable state the services are built around.
 */
export async function chooseAction(turnId: string, choiceId: string): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();
    const turn = uuid.parse(turnId);
    const choice = uuid.parse(choiceId);

    const answered = await commitChoice(user.id, turn, choice);
    const session = await sessions.getSession(user.id, answered.sessionId);

    let note = 'nothing changed';
    try {
      const consequences = await generateConsequences(user.id, turn);
      note = `${consequences.events} beat(s), ${consequences.contextEntries} background, ${consequences.relationshipStates} relationship state(s)`;
    } catch {
      note = 'answer recorded, but consequences failed — retry is safe';
    }

    revalidatePath(`/lab/${session.storylineId}`);
    return `Answered. ${note}`;
  });
}

const TRANSCRIPTS = {
  'unsent-apology': unsentApology,
  'three-weeks-later': threeWeeksLater,
} as const;

export async function extractAction(key: string): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();
    const transcript = TRANSCRIPTS[z.enum(['unsent-apology', 'three-weeks-later']).parse(key)];
    const storyline = await extractStoryline(user.id, transcript);
    revalidatePath('/lab');
    return `Extracted "${storyline.title}"`;
  });
}

export async function sweepAction(): Promise<ActionResult> {
  return run(async () => {
    await requireLabUser();
    // Zero, so every session counts as idle — the harness is not going to sit
    // still for an hour to watch this work.
    const result = await sweepIdleSessions(0);
    revalidatePath('/lab');
    return `Considered ${result.considered}, summarised ${result.written}, skipped ${result.skipped}`;
  });
}

const threadSchema = z.object({
  handle: z.string().min(1).max(300),
  messages: z
    .array(
      z.object({
        isFromMe: z.boolean(),
        handle: z.string().max(300),
        sender: z.string().max(300),
        text: z.string().min(1),
        sentAt: z.string().max(100),
      })
    )
    .min(1)
    .max(50_000),
});

/**
 * Extracts one conversation into a storyline.
 *
 * One thread per call, rather than a whole export per call, for two reasons.
 * An export does not fit in any context window, and a single story spanning
 * years and everyone in it would be incoherent even if it did. And 39 sequential
 * generations at high reasoning effort is many minutes of work — far past what
 * one request should hold open, and with no way to show progress or to keep what
 * succeeded when something fails half way.
 *
 * The parsing and splitting happen in the browser, so the export itself is never
 * uploaded; only the thread being extracted is sent. It does reach the model —
 * invariants.md §1 permits transit and forbids storage — and nothing of it is
 * written: extraction persists the model's retelling.
 */
export async function extractThreadAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();

    const parsed = threadSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('That thread is not in the expected shape.');
    const thread = parsed.data;

    const chars = thread.messages.reduce((total, message) => total + message.text.length, 0);
    if (chars > MAX_TRANSCRIPT_CHARS) {
      throw new ValidationError(
        `That thread is ${Math.round(chars / 1000)}k characters, past the ~${MAX_TRANSCRIPT_CHARS / 1000}k a single call carries.`
      );
    }

    const storyline = await extractStoryline(user.id, {
      surface: 'imessage',
      messages: thread.messages,
    });

    revalidatePath('/lab');
    return `"${storyline.title}" — ${thread.messages.length} messages`;
  });
}

export async function deleteStorylineAction(storylineId: string): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();
    const id = uuid.parse(storylineId);
    const gone = await storylineWriter.deleteStoryline(user.id, id);
    if (!gone) throw new NotFoundError('Storyline', id);
    revalidatePath('/lab');
    return 'Deleted';
  });
}

/**
 * Clears everything the seed did not create.
 *
 * Needed because the lab and its tests both write into the same development
 * database, and a fixture extraction produces a new storyline every time it
 * runs — which is how a list of nine became a list of fifty-two, forty-three of
 * them identically titled.
 */
export async function clearExtractedAction(): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();
    const removed = await storylineWriter.deleteStorylinesAfterSeed(user.id);
    revalidatePath('/lab');
    return `Removed ${removed} storyline${removed === 1 ? '' : 's'}; the seed is untouched`;
  });
}
