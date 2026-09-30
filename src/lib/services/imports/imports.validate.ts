import { z } from 'zod';
import { MAX_TRANSCRIPT_CHARS, MIN_THREAD_MESSAGES } from '../generation/limits';
import { TranscriptTooLargeError, ValidationError } from '@/lib/utils/errors';

/**
 * What a sender may be called on the wire.
 *
 * An allow-list, not a "does this look like a phone number" check, and that is
 * the whole point. A deny-list for real contact details has to anticipate every
 * international dialling format and every way an address can be written, and the
 * cost of missing one is a real phone number reaching `hashContactHandle` and
 * then a column. Two shapes are accepted and everything else is refused, so the
 * failure mode is a rejected import rather than a leaked contact.
 *
 * The Mac generates these; see `docs/import-api.md`.
 */
const HANDLE = /^(me|c_[0-9a-f]{16})$/;

const message = z.object({
  isFromMe: z.boolean(),
  handle: z.string().regex(HANDLE, 'must be "me" or a c_ pseudonym'),
  sender: z.string().min(1).max(200),
  text: z.string(),
  sentAt: z.string().datetime({ offset: true }),
});

export const importRequestSchema = z.object({
  // Opaque to the backend: it is the client's name for the thread, and the only
  // thing it is ever compared against is another value from the same client.
  conversationKey: z.string().min(1).max(200),
  transcript: z.object({
    surface: z.string().min(1).max(64),
    messages: z.array(message),
  }),
});

export type ImportRequest = z.infer<typeof importRequestSchema>;

/**
 * The checks that need a whole transcript rather than one field.
 *
 * Separate from the schema because their errors are different: too large is a
 * 413 and too short is a 400, and zod produces one status for everything. Both
 * are re-checked here even though the Mac applies them first — a limit the
 * client applies to itself is not a limit, and this endpoint is reachable by
 * anything holding a token.
 */
export function assertTranscriptIsUsable(request: ImportRequest): void {
  const { messages } = request.transcript;

  if (messages.length < MIN_THREAD_MESSAGES) {
    throw new ValidationError(
      `A conversation needs at least ${MIN_THREAD_MESSAGES} messages to be worth extracting.`,
      { 'transcript.messages': `expected at least ${MIN_THREAD_MESSAGES}, got ${messages.length}` }
    );
  }

  const chars = messages.reduce((total, m) => total + m.text.length, 0);
  if (chars > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptTooLargeError(MAX_TRANSCRIPT_CHARS);
  }

  // Oldest first is what `beatTarget` and the extraction prompt both assume;
  // reversed, the model is handed the ending as the opening.
  for (let i = 1; i < messages.length; i++) {
    if (Date.parse(messages[i].sentAt) < Date.parse(messages[i - 1].sentAt)) {
      throw new ValidationError('Messages must be ordered oldest first.', {
        'transcript.messages': `out of order at index ${i}`,
      });
    }
  }
}
