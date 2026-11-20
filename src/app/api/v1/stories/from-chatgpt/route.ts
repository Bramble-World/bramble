import { z } from 'zod';
import { withAccount } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { requestStoriesFromLink } from '@/lib/services/chatgpt/chatgpt.service';
import { RateLimitError } from '@/lib/utils/errors';

/** The most a link's note may be, after trimming. */
const MAX_CONTEXT_CHARACTERS = 6000;

const bodySchema = z.object({
  context: z.string().trim().min(1, 'Required').max(MAX_CONTEXT_CHARACTERS),
});

/**
 * Stories from a link ChatGPT wrote: `https://www.brambleworld.com/open/story#<note>`,
 * where the note is up to five situations from the player's life. Tapping it
 * opens the iPhone app, which sends the note here; the tap is the player's ok,
 * so nothing is shown first.
 *
 * The note is sorted into situations by a model, which drops anything
 * sensitive or too thin, and each one kept becomes a story exactly as
 * `write_my_story` makes one (`requestStoriesFromLink`). Only the situations
 * are kept, until each story is written; the note itself is not stored.
 *
 * Accounts only, as `/api/mcp` is: these stories keep real names and are the
 * player's own, and a guest's world is gone in 7 days. Shares the day's
 * allowance with `write_my_story`.
 *
 * Nothing on this path logs the note or anything made from it (the request log
 * reads no body), and analytics carries outcome codes and counts only.
 */
export const POST = withAccount(async (user, request) => {
  const { context } = await parseBody(request, bodySchema);

  const result = await requestStoriesFromLink(user.id, context, { signal: request.signal });

  switch (result.outcome) {
    case 'queued':
      return json(
        {
          outcome: 'queued',
          stories: result.stories,
          left: result.left,
          overLimit: result.overLimit,
        },
        { status: 202 }
      );
    case 'not_written':
      return json({ outcome: 'not_written', reason: result.reason });
    case 'limited':
      throw new RateLimitError(
        Math.max(1, Math.ceil((result.retryAt.getTime() - Date.now()) / 1000))
      );
  }
}, 'Sign up to make stories with chatgpt.');
