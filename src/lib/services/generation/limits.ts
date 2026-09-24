/**
 * Limits shared by the import UI and the action behind it.
 *
 * In their own module because `actions.ts` carries `'use server'`, and such a
 * file may export **only async functions** — a constant exported beside an
 * action breaks the build with an error that typecheck cannot see, since it is
 * a framework rule rather than a type one.
 */

/**
 * The per-call transcript ceiling, in characters of message text.
 *
 * About four characters to a token, so roughly 100k tokens. The browser splits
 * an export against this before sending; the action checks it again, because a
 * Server Action is a public endpoint and a limit the client applies to itself is
 * not a limit.
 */
export const MAX_TRANSCRIPT_CHARS = 400_000;

/**
 * How many messages a conversation needs before it is worth extracting.
 *
 * A real 45,000-message export held 440 threads with a median length of two:
 * delivery notifications and verification codes, which cost a model call each
 * and produce nothing worth reading. Fifty leaves the conversations that have a
 * shape.
 */
export const MIN_THREAD_MESSAGES = 50;
