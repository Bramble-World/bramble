import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { postgresConnection } from './ssl';

/**
 * How the database connection decides whether to verify the server.
 *
 * Worth testing at this level because the dangerous version of this code is
 * indistinguishable from the correct one in production: an unverified connection
 * succeeds, serves traffic, and reports nothing. The only way it is ever noticed
 * is by someone reading the code.
 *
 * The stripping tests are the load-bearing ones. `pg-connection-string` builds
 * its own ssl config whenever the URL carries `sslmode`, discarding any `ssl`
 * passed beside it — so a connection string that still contains `sslmode` is a
 * connection with no CA, however correct the object next to it looks.
 */

/**
 * A private directory, rather than a fixed name in the shared temp dir.
 *
 * `join(tmpdir(), 'fixed-name.pem')` is predictable and that directory is
 * world-writable, so another user on the machine can pre-create the path — as a
 * symlink somewhere else, which is then what the write lands on. `mkdtempSync`
 * makes a 0700 directory with a random suffix, so there is no name to guess and
 * nobody else can read it.
 *
 * CodeQL flags the first form as `js/insecure-temporary-file` and is right to:
 * the content here is a fake certificate, but the pattern is the one that leaks
 * a real key.
 */
const CA = join(mkdtempSync(join(tmpdir(), 'bramble-ssl-')), 'ca.pem');
writeFileSync(
  CA,
  '-----BEGIN CERTIFICATE-----\nnot a real certificate\n-----END CERTIFICATE-----\n'
);

const PLAIN = 'postgresql://u:p@localhost:5432/db';

afterEach(() => vi.unstubAllEnvs());

describe('when TLS is not asked for', () => {
  it.each([
    ['no sslmode', PLAIN],
    ['sslmode=disable', `${PLAIN}?sslmode=disable`],
    // The placeholder src/index.ts falls back to, plus anything malformed. These
    // must fail later on a connection error, not here on a certificate.
    ['an unparseable URL', 'postgresql://database-url-is-not-set'],
  ])('passes the URL through untouched and asks for no ssl: %s', (_label, url) => {
    vi.stubEnv('DATABASE_CA_PATH', CA);

    expect(postgresConnection(url)).toStrictEqual({ connectionString: url });
  });
});

describe('when TLS is asked for', () => {
  it.each([['require'], ['verify-ca'], ['verify-full']])('verifies for sslmode=%s', (mode) => {
    vi.stubEnv('DATABASE_CA_PATH', CA);

    const { ssl } = postgresConnection(`${PLAIN}?sslmode=${mode}`);

    expect(ssl).toStrictEqual({
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
      rejectUnauthorized: true,
    });
  });

  /**
   * The crux. Leaving `sslmode` in the string makes the driver build its own ssl
   * config and throw ours away — the handshake then fails with "unable to verify
   * the first certificate" however correct the object beside it was.
   */
  it('removes sslmode from the connection string', () => {
    vi.stubEnv('DATABASE_CA_PATH', CA);

    const { connectionString } = postgresConnection(`${PLAIN}?sslmode=require`);

    expect(connectionString).not.toContain('sslmode');
  });

  /**
   * All of them, not just `sslmode`: `sslrootcert` alone also makes the driver
   * take over, which would hand back the exact decision this module is making.
   */
  it('removes every ssl parameter, not only sslmode', () => {
    vi.stubEnv('DATABASE_CA_PATH', CA);

    const { connectionString } = postgresConnection(
      `${PLAIN}?sslmode=require&sslrootcert=/other/ca.pem&sslcert=/c.pem&sslkey=/k.pem`
    );

    for (const param of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
      expect(connectionString).not.toContain(param);
    }
  });

  it('keeps the parts of the URL that are not about ssl', () => {
    vi.stubEnv('DATABASE_CA_PATH', CA);

    const { connectionString } = postgresConnection(
      `${PLAIN}?sslmode=require&application_name=bramble`
    );

    expect(connectionString).toContain('application_name=bramble');
    expect(connectionString).toContain('/db');
    expect(connectionString).toContain('localhost:5432');
  });

  /**
   * Throws rather than falling back, which is the point of the module. The
   * tempting fallback is `rejectUnauthorized: false`, and it would turn a missing
   * file into a silently unverified production database.
   */
  it('throws rather than connecting unverified when the CA is unreadable', () => {
    vi.stubEnv('DATABASE_CA_PATH', join(CA, '..', 'definitely-absent.pem'));

    expect(() => postgresConnection(`${PLAIN}?sslmode=require`)).toThrow(
      /Refusing to connect without verifying/
    );
  });

  it('names the path it could not read, so the fix is obvious', () => {
    vi.stubEnv('DATABASE_CA_PATH', '/nope/missing-bundle.pem');

    expect(() => postgresConnection(`${PLAIN}?sslmode=require`)).toThrow(
      /\/nope\/missing-bundle\.pem/
    );
  });

  /** An empty value is what a templated env group produces; it is not a path. */
  it('falls back to the bundle path the Dockerfile copies to', () => {
    vi.stubEnv('DATABASE_CA_PATH', '');

    expect(() => postgresConnection(`${PLAIN}?sslmode=require`)).toThrow(/rds-global-bundle\.pem/);
  });
});
