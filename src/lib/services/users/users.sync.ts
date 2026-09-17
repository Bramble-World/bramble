import type { WebhookEvent } from '@clerk/nextjs/webhooks';
import * as reader from './users.reader';
import * as writer from './users.writer';

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
      const identity = primaryEmail(event.data);
      if (!identity) {
        // A Clerk account with no email cannot satisfy users.email NOT NULL.
        // Skip rather than fail: retrying will not conjure an address.
        return { handled: true, event: event.type, action: 'noop' };
      }

      if (event.type === 'user.created') {
        const inserted = await writer.insertUserIfAbsent({
          clerkId: event.data.id,
          email: identity.email,
          emailVerifiedAt: identity.verified ? new Date() : null,
        });
        // Already present means lazy provisioning or a redelivery beat us here.
        return { handled: true, event: event.type, action: inserted ? 'created' : 'noop' };
      }

      // Only stamp verification the first time we observe it, so the timestamp
      // records when the address was first verified rather than last touched.
      const existing = await reader.getUserByClerkIdIncludingDeleted(event.data.id);
      const updated = await writer.updateUserByClerkId(event.data.id, {
        email: identity.email,
        emailVerifiedAt: identity.verified && !existing ? new Date() : undefined,
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

function primaryEmail(data: {
  email_addresses?: {
    id: string;
    email_address: string;
    verification?: { status?: string } | null;
  }[];
  primary_email_address_id?: string | null;
}): { email: string; verified: boolean } | null {
  const addresses = data.email_addresses ?? [];
  const primary = addresses.find((a) => a.id === data.primary_email_address_id) ?? addresses[0];
  if (!primary) return null;
  return {
    email: primary.email_address,
    verified: primary.verification?.status === 'verified',
  };
}
