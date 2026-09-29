import { requireCurrentUser } from '@/lib/services/auth/auth.service';
import { PublicUser } from '@/lib/services/users/users.types';
import { handleError } from '@/lib/utils/api.handler-errors';

/**
 * The authenticate-then-handle wrapper every protected route uses.
 *
 * `src/app/api/me/route.ts` is the canonical form this is extracted from, and it
 * is deliberately left hand-written there — a reference that says "call
 * requireCurrentUser, let the thrown AppError fall through to handleError"
 * reads better as fifteen lines of the real thing than as a use of this.
 *
 * Extracted because the alternative is the same try/catch in every handler, and
 * the failure mode of that is silent: a handler that forgets the catch returns
 * Next's own error page to a client expecting the JSON envelope, and does it only
 * on the unhappy path where nobody looks.
 *
 * Handlers receive the user rather than the request-to-user step, so the rule
 * "every route is scoped to a user" holds by signature rather than by review.
 */
export function withUser<Context = unknown>(
  handler: (user: PublicUser, request: Request, context: Context) => Promise<Response>
) {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      return await handler(await requireCurrentUser(request), request, context);
    } catch (error) {
      return handleError(error);
    }
  };
}
