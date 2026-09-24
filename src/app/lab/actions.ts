'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, ValidationError } from '@/lib/utils/errors';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import * as sessions from '@/lib/services/sessions/sessions.service';
import {
  commitChoice,
  generateConsequences,
  generateTurn,
} from '@/lib/services/generation/turns.service';
import { extractStoryline } from '@/lib/services/generation/extraction.service';
import { sweepIdleSessions } from '@/lib/services/generation/arc.service';
import { threeWeeksLater, unsentApology } from '@/lib/services/generation/__fixtures__/transcripts';
import { parseCsvTranscript } from '@/lib/services/generation/csv-transcript';

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

/**
 * How much transcript one extraction call will carry.
 *
 * Checked before sending rather than after failing. A whole message history can
 * run to millions of characters, which no context window takes — and the way
 * that surfaces otherwise is a provider error several seconds into a paid call,
 * saying nothing useful about what to do next. Roughly four characters per
 * token, so this is around 100k tokens of transcript.
 */
const MAX_TRANSCRIPT_CHARS = 400_000;

/** Bigger than this and the body limit in next.config would reject it anyway. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Extracts a storyline from an uploaded message export.
 *
 * The file is read into memory, parsed, and discarded when the request ends — it
 * is never written to disk, and nothing of it is written to the database either.
 * Extraction persists the model's retelling, and the extraction tests assert no
 * message appears verbatim in any column.
 *
 * It does reach a model, so with a key configured the text leaves this machine.
 * invariants.md §1 permits that — messages may travel, they may not be stored —
 * but it is worth knowing when the input is a real history rather than a fixture.
 */
export async function extractFromUploadAction(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const user = await requireLabUser();

    const file = formData.get('csv');
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError('Choose a CSV first.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        `${file.name} is ${Math.round(file.size / 1_048_576)}MB, past the ${MAX_UPLOAD_BYTES / 1_048_576}MB upload limit.`
      );
    }

    const { transcript, mapping, totalRows, skipped } = parseCsvTranscript(await file.text());

    const size = transcript.messages.reduce((total, message) => total + message.text.length, 0);
    if (size > MAX_TRANSCRIPT_CHARS) {
      throw new ValidationError(
        `That export is ${transcript.messages.length} messages / ${Math.round(size / 1000)}k characters, past what one call can carry (~${MAX_TRANSCRIPT_CHARS / 1000}k). Narrow the file and try again.`
      );
    }

    const storyline = await extractStoryline(user.id, transcript);
    revalidatePath('/lab');

    // The column mapping is reported because a misdetection is otherwise silent:
    // the extraction would simply be wrong about who said what, and read fine.
    const columns = Object.entries(mapping)
      .map(([field, header]) => `${field}=${header ?? '—'}`)
      .join(' ');
    return `Extracted "${storyline.title}" from ${transcript.messages.length} of ${totalRows} rows (${skipped} skipped). Columns: ${columns}`;
  });
}
