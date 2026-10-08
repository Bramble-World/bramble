import { describe, expect, it, vi } from 'vitest';
import {
  ciphertextsMatch,
  decryptTranscript,
  encryptTranscript,
  type Envelope,
} from './transcript.crypto';

/**
 * The half of the privacy promise that is about data at rest.
 *
 * invariants.md §1 says message content never reaches a long-term store. Redis
 * is not one, but it is a store, and everything here is about what someone
 * holding its contents can actually do with them.
 */
const IMPORT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const transcript = {
  surface: 'imessage',
  messages: [
    {
      isFromMe: false,
      handle: 'c_9b1e04a7d2f3c611',
      sender: 'Maya',
      text: 'i really did think you knew',
      sentAt: '2026-03-02T19:04:00.000Z',
    },
  ],
};

describe('transcript encryption', () => {
  it('round-trips a transcript unchanged', () => {
    const envelope = encryptTranscript(transcript, IMPORT, USER);
    expect(decryptTranscript(envelope, IMPORT, USER)).toStrictEqual(transcript);
  });

  /**
   * The assertion the whole module exists for. Anyone holding a Redis dump has
   * this blob and nothing else — if the message survived in it, encrypting was
   * decoration.
   */
  it('leaves no message text anywhere in the envelope', () => {
    const serialised = JSON.stringify(encryptTranscript(transcript, IMPORT, USER));

    expect(serialised).not.toContain('i really did think you knew');
    expect(serialised).not.toContain('Maya');
    expect(serialised).not.toContain('imessage');
    expect(serialised).not.toContain('c_9b1e04a7d2f3c611');
  });

  // A fresh data key per import, so one recovered key does not unlock the rest,
  // and identical conversations do not produce identical blobs.
  it('encrypts the same transcript differently every time', () => {
    const a = encryptTranscript(transcript, IMPORT, USER);
    const b = encryptTranscript(transcript, IMPORT, USER);

    expect(ciphertextsMatch(a, b)).toBe(false);
    expect(a.dk.ct).not.toBe(b.dk.ct);
  });

  /**
   * The associated data binds a ciphertext to one import belonging to one
   * account. Without it a blob lifted from one Redis key and written under
   * another would decrypt perfectly — which would turn a Redis write into a way
   * to feed someone else's conversation into your own extraction.
   */
  it('refuses to decrypt under a different import', () => {
    const envelope = encryptTranscript(transcript, IMPORT, USER);
    const elsewhere = '33333333-3333-4333-8333-333333333333';

    expect(() => decryptTranscript(envelope, elsewhere, USER)).toThrow();
  });

  it('refuses to decrypt for a different account', () => {
    const envelope = encryptTranscript(transcript, IMPORT, USER);
    const stranger = '44444444-4444-4444-8444-444444444444';

    expect(() => decryptTranscript(envelope, IMPORT, stranger)).toThrow();
  });

  // GCM, not CBC: a modified ciphertext must fail rather than decrypt into
  // plausible nonsense that then reaches a model.
  it('detects a tampered ciphertext', () => {
    const envelope = encryptTranscript(transcript, IMPORT, USER);
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] ^= 0xff;

    expect(() =>
      decryptTranscript({ ...envelope, ct: bytes.toString('base64') }, IMPORT, USER)
    ).toThrow();
  });

  it('detects a swapped data key', () => {
    const mine = encryptTranscript(transcript, IMPORT, USER);
    const other = encryptTranscript(transcript, IMPORT, USER);

    expect(() => decryptTranscript({ ...mine, dk: other.dk }, IMPORT, USER)).toThrow();
  });

  it('refuses an envelope from a version it does not know', () => {
    const envelope = encryptTranscript(transcript, IMPORT, USER);

    expect(() => decryptTranscript({ ...envelope, v: 99 } as Envelope, IMPORT, USER)).toThrow(
      /not a shape this version reads/
    );
  });
});

describe('the master key', () => {
  /**
   * Absent and wrong-sized both throw, and they have to: a 16-byte key would
   * still encrypt, still produce a blob that looks correct, and still be a
   * weaker cipher than this module claims to use. The failure is invisible
   * unless it is loud.
   */
  it.each([
    ['absent', undefined],
    ['too short', Buffer.from('sixteen-byte-key', 'utf8').toString('base64')],
  ])('refuses to encrypt when the key is %s', async (_label, value) => {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { IMPORT_MASTER_KEY: value } }));
    const crypto = await import('./transcript.crypto');

    expect(() => crypto.encryptTranscript(transcript, IMPORT, USER)).toThrow(/IMPORT_MASTER_KEY/);

    vi.doUnmock('@/env');
    vi.resetModules();
  });
});
