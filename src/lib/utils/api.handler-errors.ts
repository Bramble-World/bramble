import * as Sentry from '@sentry/nextjs';
import { AppError, RateLimitError, ValidationError } from './errors';

/**
 * Turns a thrown error into a JSON response for a route handler.
 *
 * Emits `{ error: { code, message } }` — the shape `parseApiError` reads on the
 * client. Keep every handler's `catch` delegating here so 400s and 500s look
 * the same across the whole API.
 */
export function handleError(error: unknown): Response {
  if (error instanceof AppError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError && error.fields ? { fields: error.fields } : {}),
        ...(error instanceof RateLimitError ? { retryAfter: error.retryAfter } : {}),
      },
    };

    return Response.json(body, {
      status: error.statusCode,
      // Let clients honour the backoff rather than guess at it.
      headers:
        error instanceof RateLimitError ? { 'Retry-After': String(error.retryAfter) } : undefined,
    });
  }

  // Anything reaching here is a bug, not an expected failure. Report it
  // explicitly: catching the error means Next's `onRequestError` hook in
  // instrumentation.ts never sees it, so Sentry would otherwise miss it.
  Sentry.captureException(error);
  console.error('Unhandled error:', error);

  return Response.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
      },
    },
    { status: 500 }
  );
}
