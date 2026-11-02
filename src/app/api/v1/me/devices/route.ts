import { z } from 'zod';
import { withUser } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { parseBody } from '@/lib/api/params';
import { PUSH_ENVIRONMENTS } from '@/lib/services/push/push.types';
import { registerDevice, removeDevice } from '@/lib/services/push/push.service';
import { SignupRequiredError } from '@/lib/utils/errors';

/** Lowercased, so one token can't be stored twice under two spellings. */
const tokenSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{32,512}$/)
  .transform((token) => token.toLowerCase());

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const registerSchema = z.object({
  token: tokenSchema,
  environment: z.enum(PUSH_ENVIRONMENTS),
  timeZone: z.string().max(64).refine(isTimeZone),
});

const removeSchema = z.object({ token: tokenSchema });

/**
 * This install's push token. Not `withAccount`, whose refusal is about importing.
 * Notifications are for accounts: a guest has nothing saved to come back to, and
 * their row is deleted within the week.
 */
export const PUT = withUser(async (user, request) => {
  if (user.isGuest) throw new SignupRequiredError('Sign up to get notifications.');
  const device = await parseBody(request, registerSchema);
  await registerDevice(user.id, device);
  return json({ registered: true });
});

/** A body rather than a path, so the token stays out of access logs. */
export const DELETE = withUser(async (user, request) => {
  const { token } = await parseBody(request, removeSchema);
  return json({ removed: await removeDevice(user.id, token) });
});
