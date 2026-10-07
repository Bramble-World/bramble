import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/index';
import { redis } from '@/lib/redis/client';

/**
 * Readiness: can this replica actually serve a request?
 *
 * Separate from `/api/health` on purpose, and the distinction matters more than
 * it looks. Liveness answers "should this process be restarted", and must not
 * depend on anything outside the process — a database blip that fails a liveness
 * check restarts every replica at once and turns a brief outage into a cold
 * start under load. Readiness answers "should traffic be sent here", and should
 * depend on exactly the things a request needs.
 *
 * Both dependencies are required rather than advisory. Every authenticated route
 * reads Postgres, and the import path cannot accept a transcript without Redis —
 * a replica missing either one serves errors, so it should be taken out of
 * rotation rather than left to return 500s.
 *
 * Deliberately not wrapped in `withUser`: a readiness probe carries no bearer
 * token, and an endpoint that needs authentication to say whether it is up is no
 * use to a load balancer.
 */

/** Short, because a probe that hangs is a replica that never leaves rotation. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Resolves to the check's name on failure, or null on success.
 *
 * Races rather than relying on client timeouts: the Postgres pool will happily
 * queue a query for as long as it takes to get a connection, so the probe's
 * deadline has to be the probe's own.
 */
async function check(name: string, probe: () => Promise<unknown>): Promise<string | null> {
  const timeout = new Promise<string>((resolve) =>
    setTimeout(() => resolve(name), PROBE_TIMEOUT_MS)
  );

  const attempt = probe().then(
    () => null,
    // The name, never the error. Both clients put connection strings into their
    // messages, and those carry credentials.
    () => name
  );

  return Promise.race([attempt, timeout]);
}

export async function GET() {
  const failed = (
    await Promise.all([
      check('postgres', () => db.execute(sql`select 1`)),
      check('redis', () => redis('readiness is checked').ping()),
    ])
  ).filter((name): name is string => name !== null);

  if (failed.length > 0) {
    return NextResponse.json({ status: 'unavailable', failed }, { status: 503 });
  }

  return NextResponse.json({ status: 'ok' });
}
