import { z } from 'zod';
import { withGuest } from '@/lib/api/with-user';
import { ValidationError } from '@/lib/utils/errors';
import { withdrawRebornAnswer } from '@/lib/services/onboarding/reborn-answers.service';

type Params = { params: Promise<{ index: string }> };

const indexSchema = z.coerce.number().int().min(1).max(3);

/**
 * "i'd rather not say" on a question answered before: its answer is deleted.
 * **204** whether or not there was one, so a retry is harmless.
 */
export const DELETE = withGuest(async (user, _request, { params }: Params) => {
  const parsed = indexSchema.safeParse((await params).index);
  if (!parsed.success)
    throw new ValidationError('The question is 1, 2 or 3', { index: 'Between 1 and 3' });
  await withdrawRebornAnswer(user.id, parsed.data);
  return new Response(null, { status: 204 });
});
