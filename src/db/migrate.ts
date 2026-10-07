import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { postgresSsl } from './ssl';

/**
 * Applies pending migrations, then exits.
 *
 * drizzle-orm's migrator rather than drizzle-kit, because drizzle-kit is a dev
 * dependency and a build tool: it reads `drizzle.config.ts`, which imports
 * TypeScript and zod, and shipping it would mean shipping a toolchain into the
 * runtime image to run three SQL files. The migrator needs only the generated
 * SQL and the journal that is already in `src/db/drizzle`.
 *
 * Run as the deploy's pre-deploy step, which is the point of it being a separate
 * process with an exit code: a migration that fails must stop the release rather
 * than letting new code meet an old schema.
 *
 * Its own pool, deliberately — not the app's. `src/index.ts` builds a pool
 * configured for serving requests and carries the relations graph with it, and
 * importing that here would pull the schema, the env module and everything they
 * reach into a process whose only job is to replay SQL.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Loudly, and before connecting. The failure mode this avoids is the
    // placeholder URL in src/index.ts: a migrator that "succeeds" against
    // nothing would let a release through with no schema behind it.
    throw new Error('DATABASE_URL is not set, so there is nothing to migrate.');
  }

  // A single connection. The migrator runs statements in order inside one
  // session and takes an advisory lock, so a pool buys nothing and a second
  // connection sitting idle only delays the exit.
  const db = drizzle({
    connection: { connectionString, ssl: postgresSsl(connectionString), max: 1 },
  });

  const migrationsFolder = resolve(import.meta.dirname, 'drizzle');
  const applied = migrationCount(migrationsFolder);

  console.log(JSON.stringify({ event: 'migrate_started', migrations: applied }));
  await migrate(db, { migrationsFolder });
  console.log(JSON.stringify({ event: 'migrate_finished', migrations: applied }));

  await db.$client.end();
}

/**
 * How many migrations are on disk, for the log line.
 *
 * Counted rather than taken from a journal: this drizzle version keeps a
 * `snapshot.json` per migration folder and no `meta/_journal.json` at all, so
 * reading one would report zero forever.
 *
 * Reported so that a release where the migrations failed to copy into the image
 * is visible as `migrations: 0` succeeding instantly — which otherwise looks
 * exactly like a release with nothing to do.
 */
function migrationCount(folder: string): number {
  try {
    return readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    // The message only. Migration errors carry SQL, and the SQL here is schema
    // rather than data — but the habit is the point, and a stack trace in a
    // deploy log is noise next to the one line that says which statement failed.
    console.error(
      JSON.stringify({
        event: 'migrate_failed',
        error: error instanceof Error ? error.message : 'unknown',
      })
    );
    process.exit(1);
  }
);
