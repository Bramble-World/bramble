import type { WebhookEvent } from '@clerk/nextjs/webhooks';
import * as writer from './users.writer';
import { identityFromWebhookData } from './users.identity';

/** What happened, so the route can log it without re-deriving anything. */
export type SyncOutcome =
  | { handled: true; event: string; action: 'created' | 'updated' | 'deleted' | 'noop' }
  | { handled: false; event: string };

/**
 * Applies a verified Clerk webhook to the local users table.
 *
 * Everything here is idempotent and order-independent, because webhooks can be
 * redelivered and can arrive after the lazy provisioning path has already run:
 * create is insert-if-absent, update targets a live row, delete is guarded on
 * deletedAt IS NULL. An event for a user we have never seen is a no-op, not an
 * error — there is nothing to repair.
 */
export async function applyClerkUserEvent(event: WebhookEvent): Promise<SyncOutcome> {
  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const identity = identityFromWebhookData(event.data);
      if (!identity) {
        // A Clerk account with no email cannot satisfy users.email NOT NULL.
        // Skip rather than fail: retrying will not conjure an address.
        return { handled: true, event: event.type, action: 'noop' };
      }

      if (event.type === 'user.created') {
        const inserted = await writer.insertUserIfAbsent({
          clerkId: event.data.id,
          email: identity.email,
          verified: identity.verified,
        });
        // Already present means lazy provisioning or a redelivery beat us here.
        return { handled: true, event: event.type, action: inserted ? 'created' : 'noop' };
      }

      // The writer derives email_verified_at from these two fields, because the
      // answer depends on whether the address itself changed. No read needed.
      const updated = await writer.updateUserByClerkId(event.data.id, {
        email: identity.email,
        verified: identity.verified,
      });
      return { handled: true, event: event.type, action: updated ? 'updated' : 'noop' };
    }

    case 'user.deleted': {
      if (!event.data.id) return { handled: true, event: event.type, action: 'noop' };
      const deleted = await writer.softDeleteUserByClerkId(event.data.id);
      return { handled: true, event: event.type, action: deleted ? 'deleted' : 'noop' };
    }

    default:
      return { handled: false, event: event.type };
  }
}
