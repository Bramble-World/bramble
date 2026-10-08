import * as Sentry from '@sentry/nextjs';
import { AppError, ValidationError } from './errors';

/**
 * Anything that knows how long the caller should wait.
 *
 * Checked structurally rather than by class, because several unrelated errors
 * carry a backoff now — our own quota, a provider throttle, a deadline, a
 * generation already in flight — and listing them here would mean this file
 * needs editing every time another is added. It is the field that matters, not
 * the ancestry.
 */
function retryAfterOf(error: AppError): number | undefined {
  const value = (error as unknown as { retryAfter?: unknown }).retryAfter;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Turns a thrown error into a JSON response for a route handler.
 *
 * Emits `{ error: { code, message } }` — the shape `parseApiError` reads on the
 * client. Keep every handler's `catch` delegating here so 400s and 500s look
 * the same across the whole API.
 */
export function handleError(error: unknown): Response {
  if (error instanceof AppError) {
    const retryAfter = retryAfterOf(error);

    const body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError && error.fields ? { fields: error.fields } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      },
    };

    return Response.json(body, {
      status: error.statusCode,
      // Let clients honour the backoff rather than guess at it. Seconds, matching
      // the header's own unit — the field had no documented one before.
      headers: retryAfter !== undefined ? { 'Retry-After': String(retryAfter) } : undefined,
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
