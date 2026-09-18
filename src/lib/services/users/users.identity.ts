/**
 * Resolving "which of this Clerk user's email addresses is theirs?" — once.
 *
 * Two provisioning paths need this: the lazy one reads the Clerk Backend API
 * (camelCase resource) and the webhook one reads the event payload (snake_case
 * JSON). The selection rule lives here so the two cannot drift; the only thing
 * that differs is field naming, handled by the two adapters below.
 *
 * The types are structural rather than Clerk's own classes, so tests can pass
 * plain objects while the real `User` / `UserJSON` still satisfy them.
 */

/** The normalised identity both provisioning paths agree on. */
export type ClerkIdentity = {
  email: string;
  verified: boolean;
};

type AddressLike = {
  id: string;
  verification?: { status?: string | null } | null;
};

type ClerkUserLike = {
  emailAddresses?: (AddressLike & { emailAddress: string })[];
  primaryEmailAddressId?: string | null;
};

type WebhookUserLike = {
  email_addresses?: (AddressLike & { email_address: string })[];
  primary_email_address_id?: string | null;
};

/**
 * The rule: the address Clerk marks primary, else the first one.
 *
 * The fallback is order-dependent and Clerk guarantees no ordering, so it is a
 * last resort for accounts with no primary set. Both callers share it precisely
 * so that an odd account resolves the same way whichever path sees it first.
 */
function selectPrimary(
  addresses: { id: string; address: string; verified: boolean }[],
  primaryId: string | null | undefined
): ClerkIdentity | null {
  const primary = addresses.find((a) => a.id === primaryId) ?? addresses[0];
  if (!primary) return null;
  return { email: primary.address, verified: primary.verified };
}

/** Clerk treats anything other than an explicit 'verified' status as unverified. */
function isVerified(address: AddressLike): boolean {
  return address.verification?.status === 'verified';
}

/** Adapter for the Clerk Backend API resource returned by `users.getUser()`. */
export function identityFromClerkUser(user: ClerkUserLike): ClerkIdentity | null {
  // `?? []` matters: Clerk's own constructor types emailAddresses as possibly
  // undefined, and without this an absent array is a TypeError -> 500.
  const addresses = (user.emailAddresses ?? []).map((a) => ({
    id: a.id,
    address: a.emailAddress,
    verified: isVerified(a),
  }));
  return selectPrimary(addresses, user.primaryEmailAddressId);
}

/** Adapter for the `user.created` / `user.updated` webhook payload. */
export function identityFromWebhookData(data: WebhookUserLike): ClerkIdentity | null {
  const addresses = (data.email_addresses ?? []).map((a) => ({
    id: a.id,
    address: a.email_address,
    verified: isVerified(a),
  }));
  return selectPrimary(addresses, data.primary_email_address_id);
}
