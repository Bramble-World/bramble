// @vitest-environment node
// node:crypto's X509Certificate wants Node's own Buffer realm, not jsdom's.
import { describe, expect, it } from 'vitest';
import {
  AttestationError,
  decodeCbor,
  verifyAttestation,
  type AttestationInput,
} from './app-attest';
import {
  DEVELOPMENT_ATTESTATION,
  FIXTURE_APP_ID,
  FIXTURE_NOW,
  PRODUCTION_ATTESTATION,
} from './__fixtures__/app-attest';

function input(
  fixture: typeof PRODUCTION_ATTESTATION,
  overrides: Partial<AttestationInput> = {}
): AttestationInput {
  return {
    attestation: Buffer.from(fixture.attestation, 'base64'),
    challenge: Buffer.from(fixture.challenge, 'base64'),
    keyId: fixture.keyId,
    appId: FIXTURE_APP_ID,
    environment: 'production',
    now: FIXTURE_NOW,
    ...overrides,
  };
}

const refusal = (attempt: () => unknown) => {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  return null;
};

describe('verifyAttestation, against real attestations', () => {
  it('accepts a production attestation for its app', () => {
    expect(verifyAttestation(input(PRODUCTION_ATTESTATION))).toEqual({
      keyId: PRODUCTION_ATTESTATION.keyId,
      environment: 'production',
    });
  });

  it('accepts a development attestation only where development is allowed', () => {
    expect(
      verifyAttestation(input(DEVELOPMENT_ATTESTATION, { environment: 'development' }))
    ).toEqual({ keyId: DEVELOPMENT_ATTESTATION.keyId, environment: 'development' });

    expect(refusal(() => verifyAttestation(input(DEVELOPMENT_ATTESTATION)))).toBeInstanceOf(
      AttestationError
    );
  });

  it('refuses an attestation made for another app', () => {
    const error = refusal(() =>
      verifyAttestation(
        input(PRODUCTION_ATTESTATION, { appId: 'K555FJZF47.com.brambleworld.BrambleMobile' })
      )
    );
    expect(error).toBeInstanceOf(AttestationError);
    expect((error as Error).message).toBe('attested for a different app');
  });

  it('refuses it against any other challenge', () => {
    const error = refusal(() =>
      verifyAttestation(input(PRODUCTION_ATTESTATION, { challenge: Buffer.from('another one') }))
    );
    expect((error as Error).message).toBe('nonce does not match');
  });

  it('refuses it for a different key id', () => {
    const error = refusal(() =>
      verifyAttestation(input(PRODUCTION_ATTESTATION, { keyId: DEVELOPMENT_ATTESTATION.keyId }))
    );
    expect(error).toBeInstanceOf(AttestationError);
  });

  it('refuses certificates outside their validity — these expired in 2024', () => {
    const error = refusal(() =>
      verifyAttestation(input(PRODUCTION_ATTESTATION, { now: new Date('2026-10-29') }))
    );
    expect((error as Error).message).toBe('certificate is not valid now');
  });

  it('refuses bytes that are not an attestation at all', () => {
    for (const attestation of [Buffer.alloc(0), Buffer.from('nonsense'), Buffer.from([0xa0])]) {
      expect(
        refusal(() => verifyAttestation(input(PRODUCTION_ATTESTATION, { attestation })))
      ).toBeInstanceOf(AttestationError);
    }
  });

  it('refuses an attestation with anything appended', () => {
    const attestation = Buffer.concat([
      Buffer.from(PRODUCTION_ATTESTATION.attestation, 'base64'),
      Buffer.from([0x00]),
    ]);
    expect(
      (refusal(() => verifyAttestation(input(PRODUCTION_ATTESTATION, { attestation }))) as Error)
        .message
    ).toBe('trailing CBOR bytes');
  });
});

describe('decodeCbor', () => {
  it('reads the shapes App Attest uses', () => {
    // {"a": [1, -2, h'ff'], "b": "hi", "c": true}
    const bytes = Buffer.from('a3616183012141ff616262686961' + '63f5', 'hex');
    const value = decodeCbor(bytes) as Map<string, unknown>;
    expect(value.get('a')).toEqual([1, -2, Buffer.from([0xff])]);
    expect(value.get('b')).toBe('hi');
    expect(value.get('c')).toBe(true);
  });

  it('refuses indefinite lengths and truncation', () => {
    expect(() => decodeCbor(Buffer.from('5f', 'hex'))).toThrow(AttestationError);
    expect(() => decodeCbor(Buffer.from('4401', 'hex'))).toThrow(AttestationError);
  });
});
