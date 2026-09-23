import { createHmac } from 'node:crypto';
import { env } from '@/env';
import { InternalServerError } from '@/lib/utils/errors';

/**
 * A hashed contact handle. Branded so a raw phone number or email cannot be
 * passed where a hash is expected — the compiler is the only thing that can
 * tell them apart, since both are strings and a raw value written to
 * `persons.source_contact_ref` would look identical in the database.
 *
 * invariants.md §1 calls this out as failing "silently, and as a privacy breach
 * rather than a bug."
 */
declare const brand: unique symbol;
export type ContactRef = string & { readonly [brand]: 'ContactRef' };

/**
 * Normalises a handle before hashing, so the same contact reached two ways
 * produces one `persons` row.
 *
 * This has to be applied identically on the lookup path and the write path.
 * If they disagree even slightly, `idx_persons_user_contact` sees two distinct
 * values, a second row is created for a person who already exists, and
 * cross-storyline continuity quietly stops working for them — with no error
 * anywhere, because both rows are individually valid.
 */
function normalise(handle: string): string {
  const trimmed = handle.trim().toLowerCase();

  // An email contains letters, so it is left alone beyond trim-and-lowercase.
  // Leading `(` is allowed, so "(555) 010 9999" is recognised as a number and
  // not mistaken for an address.
  if (!/^[+(\d][\d\s().-]*$/.test(trimmed)) return trimmed;

  // Phone numbers arrive formatted a dozen ways: +1 (555) 010-9999,
  // 555-010-9999, 5550109999. Reduce to digits so those collapse to one value.
  const digits = trimmed.replace(/\D/g, '');

  // Then drop a North American country code, so the same number written with and
  // without it is one contact. Country code 1 is unambiguous here: every calling
  // code beginning with 1 is NANP, so an 11-digit number starting with 1 is
  // always a national number with the code attached.
  //
  // Known limitation: this is the only country code handled. A UK number written
  // +44 20 7946 0958 and 020 7946 0958 still produces two refs, and therefore two
  // `persons` rows for one human. Handling that properly needs a real phone
  // library (libphonenumber) rather than more regexes, and is worth doing before
  // any non-NANP rollout. In practice handles arriving from iMessage are already
  // E.164, so this mostly guards hand-entered values.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * Hashes a contact handle for storage as `persons.sourceContactRef`.
 *
 * HMAC rather than a plain digest, because a plain digest of a phone number is
 * not meaningfully one-way: the US keyspace is about 10^10, so anyone holding a
 * database dump can enumerate it completely in minutes and recover every
 * contact. The secret lives outside the database, so a dump alone is not enough.
 *
 * Throws when the secret is unset rather than falling back to an unkeyed hash.
 * A weaker hash would still populate the column and still look correct, which is
 * exactly the silent failure this function exists to prevent.
 */
export function hashContactHandle(handle: string): ContactRef {
  const secret = env.CONTACT_HASH_SECRET;
  if (!secret) {
    throw new InternalServerError(
      'CONTACT_HASH_SECRET is not set, so contact handles cannot be hashed.'
    );
  }
  return createHmac('sha256', secret).update(normalise(handle)).digest('hex') as ContactRef;
}
