import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalServerError } from '@/lib/utils/errors';
import { hashContactHandle } from './persons.contact';

describe('hashContactHandle', () => {
  it('is deterministic, so a lookup finds what a write stored', () => {
    expect(hashContactHandle('+1 (555) 010-9999')).toBe(hashContactHandle('+1 (555) 010-9999'));
  });

  it('does not return the handle it was given', () => {
    const handle = 'maya@example.com';
    const hashed = hashContactHandle(handle);
    expect(hashed).not.toContain(handle);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  // The whole point of de-duplication: one human, one persons row. If two
  // spellings of the same number hashed differently, the unique index on
  // (userId, sourceContactRef) would see two distinct contacts, a second person
  // row would be created, and cross-storyline continuity would quietly stop
  // working for them — with no error, because both rows are individually valid.
  it.each([
    ['+1 (555) 010-9999', '5550109999'],
    ['555-010-9999', '555 010 9999'],
    ['+15550109999', '+1 555 010 9999'],
    ['1-555-010-9999', '(555) 010 9999'],
  ])('collapses %s and %s to the same ref', (a, b) => {
    expect(hashContactHandle(a)).toBe(hashContactHandle(b));
  });

  // The documented limitation, pinned so it is a known gap rather than a
  // surprise: only the NANP country code is stripped, so the same UK number
  // written two ways still produces two refs and therefore two persons rows.
  it('does not yet collapse non-NANP numbers across formats', () => {
    expect(hashContactHandle('+44 20 7946 0958')).not.toBe(hashContactHandle('020 7946 0958'));
  });

  it.each([
    ['Maya@Example.com ', 'maya@example.com'],
    [' MAYA@EXAMPLE.COM', 'maya@example.com'],
  ])('normalises %s and %s to the same ref', (a, b) => {
    expect(hashContactHandle(a)).toBe(hashContactHandle(b));
  });

  it('keeps different contacts distinct', () => {
    expect(hashContactHandle('5550109999')).not.toBe(hashContactHandle('5550109998'));
    expect(hashContactHandle('maya@example.com')).not.toBe(hashContactHandle('sam@example.com'));
  });

  // An email contains letters, so the digit-stripping branch must not touch it.
  it('does not strip characters from an address that merely contains digits', () => {
    expect(hashContactHandle('maya99@example.com')).not.toBe(hashContactHandle('99'));
  });
});

describe('hashContactHandle without a secret', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/env');
  });

  // Refusing is the point. An unkeyed digest of a phone number is not one-way in
  // any useful sense — the US keyspace is about 10^10 — but it would populate
  // the column and look exactly as correct as a keyed one.
  it('throws rather than falling back to an unkeyed hash', async () => {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { CONTACT_HASH_SECRET: undefined } }));

    const { hashContactHandle: unkeyed } = await import('./persons.contact');
    // Re-imported module graph, so this gets its own copy of the errors module.
    const { InternalServerError: FreshInternal } = await import('@/lib/utils/errors');

    expect(() => unkeyed('5550109999')).toThrow(FreshInternal);
    expect(() => unkeyed('5550109999')).toThrow(/CONTACT_HASH_SECRET/);
    // Sanity: the statically imported class is the one the normal path uses.
    expect(new InternalServerError('x')).toBeInstanceOf(InternalServerError);
  });
});
