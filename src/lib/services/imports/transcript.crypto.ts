import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/env';
import { InternalServerError } from '@/lib/utils/errors';

/**
 * Envelope encryption for a transcript in transit through Redis.
 *
 * Two keys, not one. A random 256-bit **data key** per import encrypts the
 * transcript; the **master key** encrypts only that data key. The point is that
 * nothing on the platform can read a transcript with Redis access alone — the
 * ciphertext and the wrapped data key sit together in Redis, and neither is
 * usable without a secret that is deliberately stored somewhere else.
 *
 * AES-256-GCM on both layers, so tampering is detected rather than decrypted
 * into plausible nonsense. The associated data binds each ciphertext to the
 * import and the account it belongs to: a blob lifted from one key and written
 * under another fails to authenticate instead of silently extracting a
 * stranger's conversation into your storyline.
 *
 * invariants.md §1: message content never reaches a long-term store. This is the
 * "everywhere it rests" half of that promise.
 */

/** Bumped if the envelope's shape ever changes, so old blobs fail loudly. */
const VERSION = 1;

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

type WrappedKey = {
  iv: string;
  tag: string;
  ct: string;
};

export type Envelope = {
  v: number;
  /** The data key, encrypted under the master key. Useless without it. */
  dk: WrappedKey;
  iv: string;
  tag: string;
  ct: string;
};

/**
 * The master key, decoded and length-checked.
 *
 * Throws rather than falling back to anything, and throws the same way whether
 * the key is absent or the wrong size. A 16-byte key would still encrypt, still
 * produce a blob that looks right, and still be a weaker cipher than the one
 * this module claims to use — the failure has to be loud because the damage is
 * invisible.
 */
function masterKey(): Buffer {
  const encoded = env.IMPORT_MASTER_KEY;
  if (!encoded) {
    throw new InternalServerError(
      'IMPORT_MASTER_KEY is not set, so transcripts cannot be encrypted.'
    );
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new InternalServerError(
      `IMPORT_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`
    );
  }
  return key;
}

/**
 * Binds a ciphertext to one import belonging to one account.
 *
 * Authenticated but not encrypted, which is exactly what is wanted: it is not
 * secret, it just has to be impossible to change. Without it a blob could be
 * copied from one import's key to another's and would decrypt perfectly.
 */
function associatedData(importId: string, userId: string): Buffer {
  return Buffer.from(`${importId}:${userId}`, 'utf8');
}

function seal(plaintext: Buffer, key: Buffer, aad: Buffer): WrappedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

function open(sealed: WrappedKey, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
}

/**
 * Encrypts a transcript for one import.
 *
 * The value is serialised here rather than by the caller so that a plaintext
 * string of the transcript never exists outside this function's frame.
 */
export function encryptTranscript(value: unknown, importId: string, userId: string): Envelope {
  const aad = associatedData(importId, userId);
  const dataKey = randomBytes(KEY_BYTES);

  try {
    const body = seal(Buffer.from(JSON.stringify(value), 'utf8'), dataKey, aad);
    return { v: VERSION, dk: seal(dataKey, masterKey(), aad), ...body };
  } finally {
    // The data key is gone from the process the moment it is wrapped. It is
    // recoverable only from the envelope, and only with the master key.
    dataKey.fill(0);
  }
}

/**
 * Unwraps and decrypts. Throws if anything has been altered.
 *
 * Every failure here is the same failure to the caller — a transcript that
 * cannot be read — so nothing distinguishes a wrong account from a corrupted
 * blob from a tampered tag. Telling them apart would be a decryption oracle.
 */
export function decryptTranscript<T>(envelope: Envelope, importId: string, userId: string): T {
  if (envelope?.v !== VERSION) {
    throw new InternalServerError('That transcript envelope is not a shape this version reads.');
  }

  const aad = associatedData(importId, userId);
  const dataKey = open(envelope.dk, masterKey(), aad);

  try {
    return JSON.parse(open(envelope, dataKey, aad).toString('utf8')) as T;
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Whether two envelopes were produced from the same plaintext under the same
 * key. Test-only; exported so the crypto tests do not reach into internals.
 */
export function ciphertextsMatch(a: Envelope, b: Envelope): boolean {
  const left = Buffer.from(a.ct, 'base64');
  const right = Buffer.from(b.ct, 'base64');
  return left.length === right.length && timingSafeEqual(left, right);
}
