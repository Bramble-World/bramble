import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

/**
 * Builds the Postgres connection config, with the certificate actually verified.
 *
 * The whole module exists because of one trap, and it is worth stating precisely
 * because the obvious reading of it is wrong. `pg-connection-string` **builds its
 * own `ssl` object whenever the URL contains `sslmode`** (or `sslrootcert`,
 * `sslcert`, `sslkey`) — and that replaces any `ssl` passed alongside the
 * connection string. So `{ connectionString: '…?sslmode=require', ssl: { ca } }`
 * silently discards the CA: the driver keeps its own config and the handshake
 * fails with "unable to verify the first certificate". Verified against pg
 * 8.23.0 / pg-connection-string 2.14.0 with a real TLS server.
 *
 * libpq's own `sslmode=require` means "encrypt, but do not check who you are
 * talking to", which is an encrypted connection to anyone who can answer on the
 * port — and older `pg` implemented exactly that with
 * `rejectUnauthorized: false`. Newer versions are mid-migration toward
 * libpq-compatible semantics and warn about every mode but `verify-full`.
 *
 * Rather than depend on which end of that migration a given release sits at, this
 * strips the ssl parameters out of the URL and returns the config itself. The
 * driver is then given a plain URL and an explicit `ssl` object, which is the one
 * shape whose behaviour does not change between versions.
 */

/** Where the bundle lands in the image. Overridable for anything not on RDS. */
const DEFAULT_CA_PATH = '/etc/ssl/certs/rds-global-bundle.pem';

/**
 * The parameters that make the driver build its own ssl config.
 *
 * All of them are removed, not just `sslmode`: leaving `sslrootcert` behind would
 * hand the driver back control of exactly the decision this module is making.
 */
const SSL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation'];

export type PostgresConnection = {
  /** The URL with every ssl parameter removed. */
  connectionString: string;
  /** Undefined for a plaintext connection. */
  ssl?: ConnectionOptions;
};

function readCa(): ConnectionOptions {
  // Truthiness rather than `??`, so an empty-but-present DATABASE_CA_PATH falls
  // back to the baked-in bundle. A blank value is what a templated env group or a
  // `KEY=` line produces, and `??` would take it as a path and fail on `''`.
  const caPath = process.env.DATABASE_CA_PATH || DEFAULT_CA_PATH;

  try {
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  } catch {
    // Throws rather than falling back, and that is the point of the module. The
    // tempting fallback is `rejectUnauthorized: false`, which turns a missing
    // file into a silently unverified production database. A process that will
    // not start is the correct response to being unable to verify the server it
    // is about to send transcript-adjacent data to.
    throw new Error(
      `DATABASE_URL requests TLS but the CA bundle at ${caPath} could not be read. ` +
        'Set DATABASE_CA_PATH, or use sslmode=disable for a local database. ' +
        'Refusing to connect without verifying the server certificate.'
    );
  }
}

/**
 * Splits a database URL into a plain connection string and an explicit ssl config.
 *
 * Absent `sslmode` means no TLS, which keeps a local Postgres and a CI service
 * container working with no certificates anywhere. `disable` is the explicit
 * version of the same answer.
 */
export function postgresConnection(url: string): PostgresConnection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL. The placeholder in src/index.ts takes this path, and
    // so does any malformed value — both should fail on first query with a
    // connection error rather than here, on a certificate.
    return { connectionString: url };
  }

  const mode = parsed.searchParams.get('sslmode');
  if (mode === null || mode === 'disable') return { connectionString: url };

  for (const param of SSL_PARAMS) parsed.searchParams.delete(param);

  return { connectionString: parsed.toString(), ssl: readCa() };
}
