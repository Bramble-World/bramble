import { requireCurrentUser } from '@/lib/services/auth/auth.service';
import { PublicUser } from '@/lib/services/users/users.types';
import { handleError } from '@/lib/utils/api.handler-errors';
import { ForbiddenError, SignupRequiredError } from '@/lib/utils/errors';
import { assertClientSupported } from './client-version';

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
      // Before authentication: an old client with an expired token should be
      // told to update, not to sign in. Only a client that identified itself as
      // a macOS build we no longer serve can fail here; everything else — the
      // web, curl, a build from before the header existed — passes through.
      assertClientSupported(request);

      return await handler(await requireCurrentUser(request), request, context);
    } catch (error) {
      return handleError(error);
    }
  };
}

/**
 * `withUser` for what only an account may do.
 *
 * A guest is a real user with a real token, so `withUser` lets them through by
 * design — the play loop is theirs as much as anyone's. Routes that need an
 * account (imports today) say so here, by signature, rather than each one
 * remembering to check. Refused with `SIGNUP_REQUIRED`, whose remedy is the
 * save screen rather than a sign-out.
 */
export function withAccount<Context = unknown>(
  handler: (user: PublicUser, request: Request, context: Context) => Promise<Response>
) {
  return withUser<Context>(async (user, request, context) => {
    if (user.isGuest) throw new SignupRequiredError('Sign up to import a conversation.');
    return handler(user, request, context);
  });
}

/**
 * `withUser` for the onboarding routes, which only make sense before signing
 * up: they write a guest's one story. An account is refused with 403, because
 * writing a scripted opening into a real world is not something it can ask for.
 */
export function withGuest<Context = unknown>(
  handler: (user: PublicUser, request: Request, context: Context) => Promise<Response>
) {
  return withUser<Context>(async (user, request, context) => {
    if (!user.isGuest) throw new ForbiddenError('Onboarding is for guests.');
    return handler(user, request, context);
  });
}
