import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';
import { env } from '@/env';
import { applyClerkUserEvent } from '@/lib/services/users/users.sync';
import { handleError } from '@/lib/utils/api.handler-errors';

/**
 * Clerk user lifecycle webhook.
 *
 * Deliberately NOT bearer-authenticated: the caller is Clerk, not a user. Trust
 * comes from the Svix signature over the raw body, which verifyWebhook checks
 * against CLERK_WEBHOOK_SIGNING_SECRET. Without that secret nothing is trusted,
 * which is the correct closed default.
 *
 * Clerk retries on any non-2xx, so the status codes matter:
 *   401 — not configured, or signature invalid. Do not process.
 *   200 — verified, including events we don't handle. Retrying won't help.
 *   500 — our failure (database down). Retrying might help, so let Clerk retry.
 */
export async function POST(request: NextRequest) {
  if (!env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  let event;
  try {
    event = await verifyWebhook(request, {
      signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    // Signature, timestamp, or body mismatch. Never leak which.
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  try {
    const outcome = await applyClerkUserEvent(event);
    // 200 even when unhandled: the delivery succeeded, we just had nothing to do.
    return Response.json({ received: true, ...outcome });
  } catch (error) {
    // A real failure on our side — let handleError report it and let Clerk retry.
    return handleError(error);
  }
}
