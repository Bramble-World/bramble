import { env } from '@/env';
import { ClientTooOldError } from '@/lib/utils/errors';

/**
 * Refusing clients too old to be served correctly.
 *
 * The Mac sends `X-Bramble-Client: macos/<version> (<build>)` — for example
 * `macos/1.2 (57)`. When a shipped build can no longer be trusted against this
 * server, raising `MIN_MACOS_BUILD` past it turns every call it makes into a 426
 * telling the person to update, rather than letting it fail in whatever way its
 * own bugs dictate.
 *
 * **Everything unrecognised is let through**, and that is the important half.
 * The web app sends no such header, nor does curl, nor does any Mac build from
 * before the header existed — and a gate that refused them would take the
 * product off the air to enforce a version policy. The only thing that can fail
 * this check is a client that identified itself, as macOS, with a build number
 * we can read and that is too low.
 */

/** `macos/1.2 (57)` — platform, version, build. Whitespace is tolerated. */
const HEADER = /^([a-z]+)\/(\S+)\s*\((\d+)\)\s*$/i;

export const CLIENT_HEADER = 'x-bramble-client';

export type ClientIdentity = {
  platform: string;
  version: string;
  build: number;
};

/**
 * Reads the header, or returns null for anything it does not recognise.
 *
 * Null is not an error here — it is the ordinary answer for every caller that is
 * not the Mac app. See the module comment.
 */
export function parseClientHeader(value: string | null): ClientIdentity | null {
  if (!value) return null;

  const match = HEADER.exec(value.trim());
  if (!match) return null;

  const build = Number(match[3]);
  // The regex already guarantees digits, so this only catches a number too large
  // to be exact — at which point it is certainly not below any minimum.
  if (!Number.isSafeInteger(build)) return null;

  return { platform: match[1].toLowerCase(), version: match[2], build };
}

/**
 * Throws when this request comes from a macOS build we no longer serve.
 *
 * Checked before authentication, deliberately. An old client with an expired
 * token should be told to update rather than to sign in — the update is the
 * thing that will actually help, and the sign-in would not fix it. It also
 * avoids an identity-provider round trip for a request that cannot be served.
 *
 * Health is not exempted here by path, because it does not pass through this
 * function at all: `/api/health` is hand-written and does not use `withUser`. An
 * uptime check is therefore unaffected by construction rather than by a rule
 * someone has to remember to keep in step.
 */
export function assertClientSupported(request: Request): void {
  const minimum = env.MIN_MACOS_BUILD;
  // A short-circuit, not a behavioural guard: no build can be below zero, so
  // removing this would change no answer. It is here so that the default
  // configuration — the gate off, which is every environment that has not set
  // it — does not read and parse a header on every single request.
  if (minimum <= 0) return;

  const client = parseClientHeader(request.headers.get(CLIENT_HEADER));
  // Only macOS is gated. Another platform identifying itself is not something
  // this minimum has an opinion about, and guessing would lock out a client we
  // have not shipped yet.
  if (client?.platform !== 'macos') return;

  if (client.build < minimum) throw new ClientTooOldError();
}
