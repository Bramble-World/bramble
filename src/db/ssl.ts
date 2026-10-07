import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

/**
 * TLS for the Postgres connection, with the certificate actually verified.
 *
 * node-postgres reads `sslmode` out of the connection string itself, and for
 * `sslmode=require` it sets `rejectUnauthorized: false` — because that is what
 * libpq's `require` means: encrypt, but do not check who you are talking to.
 * That is an encrypted connection to anyone who can answer on the port, which
 * buys nothing against the attack TLS is for. Passing an explicit `ssl` object
 * overrides it, which is why this exists at all rather than being left to the URL.
 *
 * The CA is AWS's RDS global bundle, vendored into the repo and copied into the
 * image. Fetched at build time it would make every build — and every CI run —
 * depend on `truststore.pki.rds.amazonaws.com` being reachable, which is a
 * strange thing for a Dockerfile to need. The trade is that rotating it is a
 * commit; the bundle's roots run to 2061, so that is not a frequent one.
 */

/** Where the bundle lands in the image. Overridable for anything not on RDS. */
const DEFAULT_CA_PATH = '/etc/ssl/certs/rds-global-bundle.pem';

/**
 * Whether this URL is asking for TLS at all.
 *
 * Absent `sslmode` means no, which keeps a local Postgres and a CI service
 * container working with no certificates anywhere. `disable` is the explicit
 * version of the same answer.
 */
function wantsTls(url: string): boolean {
  const mode = new URL(url).searchParams.get('sslmode');
  return mode !== null && mode !== 'disable';
}

/**
 * Returns the `ssl` option for a pool, or undefined for a plaintext connection.
 *
 * Throws when TLS is wanted and the CA cannot be read. That is deliberate and it
 * is the whole point of the module: the tempting fallback is
 * `rejectUnauthorized: false`, which turns a missing file into a silently
 * unverified production database. A process that will not start is the correct
 * response to being unable to verify the server it is about to send
 * transcripts-adjacent data to.
 */
export function postgresSsl(url: string | undefined): ConnectionOptions | undefined {
  if (!url) return undefined;

  let tls: boolean;
  try {
    tls = wantsTls(url);
  } catch {
    // Not a parseable URL. The placeholder in src/index.ts takes this path, and
    // so does any malformed value — both should fail on first query with a
    // connection error rather than here, on a certificate.
    return undefined;
  }

  if (!tls) return undefined;

  const caPath = process.env.DATABASE_CA_PATH ?? DEFAULT_CA_PATH;

  let ca: string;
  try {
    ca = readFileSync(caPath, 'utf8');
  } catch {
    throw new Error(
      `DATABASE_URL requests TLS but the CA bundle at ${caPath} could not be read. ` +
        'Set DATABASE_CA_PATH, or use sslmode=disable for a local database. ' +
        'Refusing to connect without verifying the server certificate.'
    );
  }

  return { ca, rejectUnauthorized: true };
}
