import { z } from 'zod';
import { withAccount } from '@/lib/api/with-user';
import { parseOptionalBody } from '@/lib/api/params';
import { clerkFirstFactorAgeMinutes } from '@/lib/services/auth/auth.service';
import { deleteAccount } from '@/lib/services/users/account-deletion';

const bodySchema = z
  .object({
    // A fresh Sign in with Apple's authorization code, for an account with Apple.
    appleAuthorizationCode: z.string().min(1).max(4096).optional(),
  })
  .strict();

/**
 * Deletes the reader's account and everything in it, now. See
 * account-deletion.ts for what goes and in what order.
 *
 * Accounts only: a guest has no Clerk user, Apple sign-in or account to
 * remove, and their story goes when it expires or they sign out on the phone.
 *
 * 204 on success. After it, the session's token no longer works.
 */
export const DELETE = withAccount(async (user, request) => {
  // Optional: an account without Apple sends no body.
  const { appleAuthorizationCode } = await parseOptionalBody(request, bodySchema);

  await deleteAccount(user, {
    firstFactorAgeMinutes: await clerkFirstFactorAgeMinutes(request),
    appleAuthorizationCode,
  });
  return new Response(null, { status: 204 });
});
