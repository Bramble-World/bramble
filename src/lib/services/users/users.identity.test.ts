import { describe, expect, it } from 'vitest';
import { identityFromClerkUser, identityFromWebhookData } from './users.identity';

// Two payload shapes, one selection rule. These tests exist because the rule
// used to be implemented twice and drifted — see the case bug in fc3f1cd.

const api = (
  addresses: { id: string; emailAddress: string; status?: string }[],
  primaryId?: string | null
) => ({
  emailAddresses: addresses.map((a) => ({
    id: a.id,
    emailAddress: a.emailAddress,
    verification: a.status === undefined ? null : { status: a.status },
  })),
  primaryEmailAddressId: primaryId,
});

const hook = (
  addresses: { id: string; emailAddress: string; status?: string }[],
  primaryId?: string | null
) => ({
  email_addresses: addresses.map((a) => ({
    id: a.id,
    email_address: a.emailAddress,
    verification: a.status === undefined ? null : { status: a.status },
  })),
  primary_email_address_id: primaryId,
});

const ONE = [{ id: 'idn_1', emailAddress: 'a@b.com', status: 'verified' }];
const TWO = [
  { id: 'idn_1', emailAddress: 'first@b.com', status: 'verified' },
  { id: 'idn_2', emailAddress: 'primary@b.com', status: 'verified' },
];

describe('the two adapters agree', () => {
  // Each case is the same logical account expressed in both shapes. Both
  // adapters must produce an identical identity — that equality is the contract
  // the two provisioning paths depend on.
  const cases: [string, Parameters<typeof api>][] = [
    ['single verified address', [ONE, 'idn_1']],
    ['primary chosen over first', [TWO, 'idn_2']],
    ['primary id matches nothing, falls back to first', [TWO, 'idn_missing']],
    ['no primary id at all', [TWO, null]],
    [
      'unverified address',
      [[{ id: 'idn_1', emailAddress: 'a@b.com', status: 'unverified' }], 'idn_1'],
    ],
    ['no verification object', [[{ id: 'idn_1', emailAddress: 'a@b.com' }], 'idn_1']],
    ['no addresses', [[], null]],
  ];

  it.each(cases)('%s', (_label, args) => {
    expect(identityFromClerkUser(api(...args))).toEqual(identityFromWebhookData(hook(...args)));
  });
});

describe('the selection rule', () => {
  it('prefers the address Clerk marks primary', () => {
    expect(identityFromClerkUser(api(TWO, 'idn_2'))?.email).toBe('primary@b.com');
    expect(identityFromWebhookData(hook(TWO, 'idn_2'))?.email).toBe('primary@b.com');
  });

  it('falls back to the first address when the primary id matches nothing', () => {
    // Previously untested, and the case where the two paths could have differed.
    expect(identityFromClerkUser(api(TWO, 'idn_missing'))?.email).toBe('first@b.com');
    expect(identityFromWebhookData(hook(TWO, 'idn_missing'))?.email).toBe('first@b.com');
  });

  it('returns null when there are no addresses', () => {
    expect(identityFromClerkUser(api([], null))).toBeNull();
    expect(identityFromWebhookData(hook([], null))).toBeNull();
  });

  it('tolerates the address array being absent entirely', () => {
    // The lazy path used to throw a TypeError here, surfacing as a 500.
    expect(identityFromClerkUser({})).toBeNull();
    expect(identityFromWebhookData({})).toBeNull();
  });

  it('treats only an explicit verified status as verified', () => {
    for (const status of ['unverified', 'transferable', 'failed', 'expired']) {
      expect(
        identityFromClerkUser(api([{ id: 'i', emailAddress: 'a@b.com', status }], 'i'))
      ).toEqual({ email: 'a@b.com', verified: false });
    }
    expect(
      identityFromClerkUser(api([{ id: 'i', emailAddress: 'a@b.com', status: 'verified' }], 'i'))
    ).toEqual({ email: 'a@b.com', verified: true });
  });
});
