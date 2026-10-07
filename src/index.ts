import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from './env';
import { relations } from './db/relations';
import { postgresSsl } from './db/ssl';

// Fall back to a placeholder URL rather than passing undefined. `drizzle(undefined)`
// throws a TypeError during module evaluation, which would take down any route that
// merely imports this file — turning a 401 into a 500 wherever DATABASE_URL is unset
// (CI runs the app with no secrets at all). A bad URL constructs lazily and fails on
// first query instead, which is the honest failure point.
//
// `relations` is what gives this instance `db.query.*`. Without it the property
// exists but is empty, and every nested read has to be hand-joined.
const connectionString = env.DATABASE_URL ?? 'postgresql://database-url-is-not-set';

export const db = drizzle({
  // `ssl` has to be passed here rather than left to `sslmode` in the URL:
  // node-postgres reads that itself and answers `require` with
  // `rejectUnauthorized: false`, which encrypts without verifying anything.
  connection: { connectionString, ssl: postgresSsl(env.DATABASE_URL) },
  relations,
});
