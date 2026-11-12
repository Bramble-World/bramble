import { z } from 'zod';
import { env } from '@/env';
import { UpstreamBusyError } from '@/lib/utils/errors';

/**
 * The safety check on a reborn answer: does it talk about self-harm, abuse or
 * someone in danger? If so the iPhone shows its care check instead of moving
 * on, and the answer is discarded rather than stored.
 *
 * OpenAI's moderation endpoint, called directly: the AI SDK has no route to it,
 * it is free, and it answers well inside the iPhone's one-second wait, where a
 * prompt to our own model would not. Its categories are fixed, so a vague worry
 * may pass; the stories written from answers get their own check before anyone
 * plays them.
 *
 * The answer is sent to OpenAI and nowhere else. Nothing here logs it, and an
 * error from here never carries it: the route's catch-all would put it in the
 * logs and in Sentry.
 */

export type SafetyVerdict = { flagged: boolean };
export type SafetyCheck = (text: string) => Promise<SafetyVerdict>;

/**
 * How long each try at moderation gets: a first try, then one more if the
 * first timed out or OpenAI failed on its side.
 *
 * Together under the iPhone's three-second wait, with room for the round trip,
 * so a slow first try still ends in an answer the app is there to hear (and a
 * care check it can show). 800 ms in one try was timing out in production.
 */
export const SAFETY_CHECK_ATTEMPTS_MS = [1600, 1000] as const;

/** What the iPhone waits for the check before moving on without it. */
export const IPHONE_WAIT_MS = 3000;

const MODERATION_URL = 'https://api.openai.com/v1/moderations';
const MODERATION_MODEL = 'omni-moderation-latest';

/**
 * The moderation categories that flag an answer: hurting oneself, a child in
 * sexual content, violence (which is how abuse shows up: "he hit me"), and
 * threats. Not hate or plain harassment: an answer about a cruel boss is a
 * story, not a crisis.
 */
export const FLAGGING_CATEGORIES = [
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual/minors',
  'violence',
  'violence/graphic',
  'harassment/threatening',
] as const;

/** Whether moderation's categories call for the care check. */
export function isFlagged(categories: Record<string, boolean>): boolean {
  return FLAGGING_CATEGORIES.some((category) => categories[category] === true);
}

const moderationResponse = z.object({
  results: z.array(z.object({ categories: z.record(z.string(), z.boolean()) })).min(1),
});

/**
 * The live check. A failure of any kind (a timeout, OpenAI down or busy, a
 * reply in a shape we don't know) is `UpstreamBusyError`: the answer is not
 * stored unchecked, and the iPhone, which only waits a second anyway, moves on.
 */
export function createModerationCheck(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): SafetyCheck {
  return async (text) => {
    let response: Response | undefined;
    for (const [attempt, deadline] of SAFETY_CHECK_ATTEMPTS_MS.entries()) {
      const last = attempt === SAFETY_CHECK_ATTEMPTS_MS.length - 1;
      try {
        response = await fetchImpl(MODERATION_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
          signal: AbortSignal.timeout(deadline),
        });
      } catch (error) {
        // Only the kind of failure: a fetch error can quote the request.
        const reason = error instanceof Error ? error.name : 'unknown';
        if (!last) {
          console.warn('reborn safety check retrying', { reason });
          continue;
        }
        console.warn('reborn safety check failed', { reason });
        throw new UpstreamBusyError(5);
      }
      // OpenAI failing on its side is worth one more try; being told to slow
      // down is not.
      if (response.status >= 500 && !last) {
        console.warn('reborn safety check retrying', { reason: `http ${response.status}` });
        continue;
      }
      break;
    }
    if (!response) throw new UpstreamBusyError(5);
    if (!response.ok) {
      console.warn('reborn safety check failed', { reason: `http ${response.status}` });
      throw new UpstreamBusyError(response.status === 429 ? 30 : 5);
    }
    const parsed = moderationResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      console.warn('reborn safety check failed', { reason: 'unexpected response' });
      throw new UpstreamBusyError(5);
    }
    return { flagged: isFlagged(parsed.data.results[0].categories) };
  };
}

/** Flags nothing. For local play with no key, and `BRAMBLE_AI_MODE=fake`. */
export const passingCheck: SafetyCheck = async () => ({ flagged: false });

let live: SafetyCheck | null = null;

/** The check this process uses: live with a key, otherwise one that passes everything. */
export function getSafetyCheck(): SafetyCheck {
  if (env.BRAMBLE_AI_MODE === 'fake' || !env.OPENAI_API_KEY) return passingCheck;
  return (live ??= createModerationCheck(env.OPENAI_API_KEY));
}
