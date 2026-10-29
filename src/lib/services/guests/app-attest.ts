import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';

/**
 * Verifies an Apple App Attest attestation object — the proof that a request
 * comes from a genuine install of our app on a real Apple device.
 *
 * Implemented here on `node:crypto` rather than taken from a library, after
 * looking at the two maintained-ish candidates:
 *
 * - `node-app-attest` (MIT, last release Feb 2026, one maintainer) pulls in
 *   `cbor`, `asn1js` and `pkijs` for what is a few dozen bytes of parsing, and
 *   it never checks certificate validity dates — its own test fixtures expired
 *   in 2024 and still pass. It also accepts either environment whenever
 *   development is allowed, and is typed `any` throughout.
 * - `appattest-checker-node` (Apache-2.0) has not been released since 2024 and
 *   ships `@types/*` packages as runtime dependencies.
 *
 * Apple's procedure is nine steps over two certificates and one byte array.
 * `node:crypto` does the cryptography (chain signatures, dates, key export);
 * all this file adds is a definite-length CBOR reader and a DER walk to find one
 * extension, both small enough to read in full. Each step below is numbered as
 * in Apple's "Validating apps that connect to your server".
 *
 * Pure: no I/O, no clock unless given one, no environment. The caller owns the
 * challenge (single use, from Redis) and the policy (which environment).
 */

/**
 * Apple App Attestation Root CA, from
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * SHA-256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:
 * 4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32. Valid until 2045.
 */
const APPLE_APP_ATTESTATION_ROOT_CA = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`);

/**
 * The content octets of OID 1.2.840.113635.100.8.2, the credential certificate
 * extension that carries the nonce.
 */
const NONCE_EXTENSION_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop', 'ascii');
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]);

export type AppAttestEnvironment = 'production' | 'development';

export type AttestationInput = {
  /** The attestation object from `DCAppAttestService.attestKey`, raw bytes. */
  attestation: Buffer;
  /** The exact bytes the app hashed into `clientDataHash`. */
  challenge: Buffer;
  /** The key identifier from `generateKey`, base64 as the app holds it. */
  keyId: string;
  /** `<team id>.<bundle id>`. */
  appId: string;
  /**
   * 'production' accepts only the production environment; 'development' also
   * accepts development-signed builds, which Xcode installs produce.
   */
  environment: AppAttestEnvironment;
  /** When to judge certificate validity at. Injected for tests; defaults to now. */
  now?: Date;
};

export type VerifiedAttestation = {
  keyId: string;
  environment: AppAttestEnvironment;
};

/**
 * Why an attestation was refused. Internal: the route answers every one of
 * these the same way, so a caller probing it learns nothing about which check
 * it failed.
 */
export class AttestationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AttestationError';
  }
}

export function verifyAttestation(input: AttestationInput): VerifiedAttestation {
  const now = input.now ?? new Date();
  const keyIdBytes = Buffer.from(input.keyId, 'base64');
  if (keyIdBytes.length !== 32) throw new AttestationError('key id is not 32 bytes');

  const object = decodeCbor(input.attestation);
  const fmt = field(object, 'fmt');
  const attStmt = field(object, 'attStmt');
  const authData = field(object, 'authData');
  const x5c = attStmt instanceof Map ? attStmt.get('x5c') : undefined;
  if (
    fmt !== 'apple-appattest' ||
    !Buffer.isBuffer(authData) ||
    !Array.isArray(x5c) ||
    x5c.length < 2 ||
    !x5c.every((c) => Buffer.isBuffer(c))
  ) {
    throw new AttestationError('not an App Attest attestation object');
  }

  // 1. The chain: credential certificate ← intermediate ← Apple's root, each
  //    signed by the next and each valid now. Position matters — Apple puts the
  //    credential certificate first — so nothing is chosen by subject name.
  let credCert: X509Certificate;
  let intermediate: X509Certificate;
  try {
    credCert = new X509Certificate(x5c[0] as Buffer);
    intermediate = new X509Certificate(x5c[1] as Buffer);
  } catch {
    throw new AttestationError('unreadable certificate');
  }
  assertSignedBy(credCert, intermediate, now);
  assertSignedBy(intermediate, APPLE_APP_ATTESTATION_ROOT_CA, now);

  // 2–3. nonce = SHA256(authData ‖ SHA256(challenge)).
  const clientDataHash = sha256(input.challenge);
  const nonce = sha256(Buffer.concat([authData, clientDataHash]));

  // 4. The credential certificate commits to that nonce.
  const committed = nonceFromCertificate(credCert.raw);
  if (!committed || !safeEqual(committed, nonce)) {
    throw new AttestationError('nonce does not match');
  }

  // 5. The key id is the SHA256 of the credential's public key, as an
  //    uncompressed EC point.
  if (!safeEqual(sha256(rawPublicKey(credCert)), keyIdBytes)) {
    throw new AttestationError('key id does not match the certificate');
  }

  // authData: rpIdHash(32) flags(1) signCount(4) aaguid(16) credIdLen(2) credId
  if (authData.length < 55) throw new AttestationError('authenticator data is too short');

  // 6. Issued for our app and no other.
  if (!safeEqual(authData.subarray(0, 32), sha256(Buffer.from(input.appId, 'utf8')))) {
    throw new AttestationError('attested for a different app');
  }

  // 7. A fresh key: the counter starts at zero.
  if (authData.readUInt32BE(33) !== 0) throw new AttestationError('counter is not zero');

  // 8. The environment the key was made in.
  const aaguid = authData.subarray(37, 53);
  const environment: AppAttestEnvironment | null = aaguid.equals(AAGUID_PRODUCTION)
    ? 'production'
    : aaguid.equals(AAGUID_DEVELOPMENT)
      ? 'development'
      : null;
  if (!environment) throw new AttestationError('unknown environment');
  if (environment === 'development' && input.environment !== 'development') {
    throw new AttestationError('development attestation in production');
  }

  // 9. The credential id is the key id.
  const credentialIdLength = authData.readUInt16BE(53);
  const credentialId = authData.subarray(55, 55 + credentialIdLength);
  if (!safeEqual(credentialId, keyIdBytes)) {
    throw new AttestationError('credential id does not match the key id');
  }

  return { keyId: keyIdBytes.toString('base64'), environment };
}

function assertSignedBy(cert: X509Certificate, issuer: X509Certificate, now: Date): void {
  if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
    throw new AttestationError('certificate chain does not reach Apple');
  }
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
    throw new AttestationError('certificate is not valid now');
  }
}

/** The credential's EC public key as `04 ‖ x ‖ y`, which is what Apple hashes. */
function rawPublicKey(cert: X509Certificate): Buffer {
  const jwk = cert.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || !jwk.x || !jwk.y) throw new AttestationError('not an EC key');
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function field(value: unknown, key: string): unknown {
  return value instanceof Map ? value.get(key) : undefined;
}

// ── DER ──────────────────────────────────────────────────────────────────────

type Tlv = { tag: number; content: Buffer; end: number };

function readTlv(der: Buffer, offset: number): Tlv {
  if (offset + 2 > der.length) throw new AttestationError('truncated DER');
  const tag = der[offset];
  let length = der[offset + 1];
  let cursor = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 4 || cursor + bytes > der.length) {
      throw new AttestationError('unsupported DER length');
    }
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + der[cursor + i];
    cursor += bytes;
  }
  const end = cursor + length;
  if (end > der.length) throw new AttestationError('truncated DER');
  return { tag, content: der.subarray(cursor, end), end };
}

function children(content: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < content.length) {
    const tlv = readTlv(content, offset);
    out.push(tlv);
    offset = tlv.end;
  }
  return out;
}

/**
 * The 32-byte nonce from extension 1.2.840.113635.100.8.2, or null.
 *
 * Walks every constructed element looking for the `Extension` SEQUENCE whose
 * first child is that OID; its last child is the OCTET STRING `extnValue`,
 * which holds `SEQUENCE { [1] { OCTET STRING nonce } }`. Searching rather than
 * walking the fixed path through `tbsCertificate` keeps this to the one shape
 * that matters, and a certificate with no such extension simply returns null.
 */
function nonceFromCertificate(der: Buffer): Buffer | null {
  const stack: Tlv[] = [readTlv(der, 0)];
  while (stack.length) {
    const node = stack.pop()!;
    if (!(node.tag & 0x20)) continue; // primitive: nothing inside to search
    const kids = children(node.content);
    const first = kids[0];
    if (node.tag === 0x30 && first?.tag === 0x06 && first.content.equals(NONCE_EXTENSION_OID)) {
      const extnValue = kids.at(-1);
      if (extnValue?.tag !== 0x04) return null;
      const sequence = readTlv(extnValue.content, 0);
      if (sequence.tag !== 0x30) return null;
      const tagged = children(sequence.content).find((kid) => kid.tag === 0xa1);
      if (!tagged) return null;
      const octets = readTlv(tagged.content, 0);
      return octets.tag === 0x04 ? octets.content : null;
    }
    stack.push(...kids);
  }
  return null;
}

// ── CBOR ─────────────────────────────────────────────────────────────────────

/**
 * Decodes one CBOR item: unsigned and negative integers, byte and text
 * strings, arrays, maps, tags (unwrapped) and the simple values. Definite
 * lengths only — App Attest never emits indefinite ones, and refusing them keeps
 * the reader small. Trailing bytes are an error, so two concatenated objects
 * cannot smuggle a second one past the first.
 */
export function decodeCbor(bytes: Buffer): unknown {
  const reader = { offset: 0 };
  const value = readItem(bytes, reader, 0);
  if (reader.offset !== bytes.length) throw new AttestationError('trailing CBOR bytes');
  return value;
}

const MAX_DEPTH = 16;

function readItem(bytes: Buffer, reader: { offset: number }, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new AttestationError('CBOR nested too deeply');
  if (reader.offset >= bytes.length) throw new AttestationError('truncated CBOR');

  const initial = bytes[reader.offset++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    throw new AttestationError('unsupported CBOR simple value');
  }

  const argument = readArgument(bytes, reader, info);

  switch (major) {
    case 0:
      return argument;
    case 1:
      return -1 - argument;
    case 2:
    case 3: {
      const end = reader.offset + argument;
      if (end > bytes.length) throw new AttestationError('truncated CBOR');
      const slice = bytes.subarray(reader.offset, end);
      reader.offset = end;
      return major === 2 ? Buffer.from(slice) : slice.toString('utf8');
    }
    case 4: {
      const items: unknown[] = [];
      for (let i = 0; i < argument; i++) items.push(readItem(bytes, reader, depth + 1));
      return items;
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < argument; i++) {
        const key = readItem(bytes, reader, depth + 1);
        map.set(key, readItem(bytes, reader, depth + 1));
      }
      return map;
    }
    case 6:
      return readItem(bytes, reader, depth + 1);
    default:
      throw new AttestationError('unsupported CBOR type');
  }
}

function readArgument(bytes: Buffer, reader: { offset: number }, info: number): number {
  if (info < 24) return info;
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (width === 0) throw new AttestationError('unsupported CBOR length');
  if (reader.offset + width > bytes.length) throw new AttestationError('truncated CBOR');

  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + bytes[reader.offset + i];
  reader.offset += width;
  // Nothing in an attestation is anywhere near this, and past it a JS number
  // stops being exact — so a larger length is a malformed or hostile object.
  if (value > 0xffffffff) throw new AttestationError('CBOR length out of range');
  return value;
}
