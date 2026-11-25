import { ClientTooOldError } from '@/lib/utils/errors';

/**
 * Which clients are served.
 *
 * The Mac sent `X-Bramble-Client: macos/<version> (<build>)` (for example
 * `macos/1.0 (11)`) and the iPhone sends `ios/…`. Bramble for Mac has ended, so
 * every Mac build is refused with a 426, which its "time to update" screen
 * answers by installing the last Mac build, which says the app has ended.
 *
 * **Everything unrecognised is let through.** The web app sends no such header,
 * nor does curl, and a gate that refused them would take the product off the
 * air.
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
  // Bramble for Mac has ended (2026-11-25, the user's call). Every Mac build
  // that talks to the API is refused: its "time to update" screen installs the
  // last Mac build from the update feed, which shows that the app has ended and
  // calls nothing. Only macOS is refused; anything else is served.
  if (parseClientHeader(request.headers.get(CLIENT_HEADER))?.platform === 'macos') {
    throw new ClientTooOldError();
  }
}

/**
 * Whether this client can show a story's ending.
 *
 * The Mac app cannot: it renders an ending as a beat with no buttons, and an
 * ended session as a state it doesn't recognise, and no Mac update is coming to
 * teach it. So stories played on the Mac stay endless while it winds down.
 * Anything else, including a request that doesn't say what it is, gets endings.
 */
/**
 * The first iPhone build that knows a reply can come later ("the story texts
 * you", iOS #68): older ones would show a pending reply as a failed beat, so
 * only this build and later may be given a pause, whatever the rollout says.
 */
export const MIN_IOS_BUILD_FOR_PAUSES = 40;

/** Whether the requesting app can show a pause (`MIN_IOS_BUILD_FOR_PAUSES`). */
export function clientShowsPauses(request: Request): boolean {
  const client = parseClientHeader(request.headers.get(CLIENT_HEADER));
  return client?.platform === 'ios' && client.build >= MIN_IOS_BUILD_FOR_PAUSES;
}

export function clientShowsEndings(request: Request): boolean {
  return parseClientHeader(request.headers.get(CLIENT_HEADER))?.platform !== 'macos';
}
