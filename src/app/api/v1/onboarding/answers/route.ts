import { z } from 'zod';
import { withGuest } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { REBORN_ROLES, saveRebornAnswer } from '@/lib/services/onboarding/reborn-answers.service';

/** The iPhone's own limit on an answer. */
const MAX_ANSWER_CHARACTERS = 140;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const bodySchema = z
  .object({
    index: z.number().int().min(1).max(3),
    role: z.enum(REBORN_ROLES).optional(),
    text: z
      .string()
      .trim()
      .min(1, 'Required')
      // Counted as the iPhone counts characters: grapheme clusters.
      .refine(
        (text) => [...graphemes.segment(text)].length <= MAX_ANSWER_CHARACTERS,
        `At most ${MAX_ANSWER_CHARACTERS} characters`
      )
      // Line breaks are fine in an answer; other control characters aren't.
      .refine((text) => !/[^\P{Cc}\n]/u.test(text), 'Letters, not control characters'),
  })
  .refine((body) => body.role === undefined || body.index === 2, {
    message: 'Only question 2 has a role',
    path: ['role'],
  });

/**
 * One of the reborn onboarding's three answers about the player's "last life".
 *
 * Checked for safety first. **`flagged: true`** means it talks about self-harm,
 * abuse or someone in danger: it is discarded (and any earlier answer to the
 * question removed), and the iPhone shows its care check. Otherwise it is kept
 * on the guest, replacing any earlier answer to the same question. A check that
 * can't be run is **429 `UPSTREAM_BUSY`**, and nothing is kept.
 *
 * The text is sent to OpenAI's moderation endpoint and stored; nothing on this
 * path logs it, and analytics never carries it.
 */
export const POST = withGuest(async (user, request) => {
  const body = await parseBody(request, bodySchema);
  const { flagged } = await saveRebornAnswer(user.id, {
    question: body.index,
    role: body.role ?? null,
    text: body.text,
  });
  return json({ ok: true, flagged });
});
