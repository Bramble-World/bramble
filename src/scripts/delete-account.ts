/**
 * Deletes a person's Bramble account and all of their data, on request.
 *
 * For a player who can't delete in the app (DELETE /api/v1/me): no app, or no
 * way to sign in. The privacy policy promises that emailing us deletes an
 * account within 30 days. Deleting the user in Clerk is not enough: its webhook only soft-deletes,
 * so every story would stay. This removes the user rows (everything they own
 * cascades) and then the Clerk accounts with that email.
 *
 * Production's database is only reachable from inside the cluster, so it runs
 * there from the bundle:
 *
 *   porter app run bramble -- node dist/scripts/delete-account.js someone@example.com
 *   porter app run bramble -- node dist/scripts/delete-account.js someone@example.com --confirm
 *
 * Without --confirm it only reports what it would delete. Locally:
 *
 *   doppler run -- pnpm tsx src/scripts/delete-account.ts someone@example.com [--confirm]
 *
 * Prints ids only. The email is the one thing it was given; nothing else about
 * the person is written to the log.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/index';
import { storylines, users } from '@/db/schema/tables';
import { clerkBackend } from '@/lib/services/auth/auth.client';
import { purgeUsersByEmail } from '@/lib/services/users/users.writer';

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email || !email.includes('@')) {
    console.error('usage: delete-account <email> [--confirm]');
    process.exit(2);
  }
  const confirm = flag === '--confirm';
  const normalized = email.trim().toLowerCase();

  const rows = await db
    .select({ id: users.id, clerkId: users.clerkId, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, normalized));
  const ids = rows.map((r) => r.id);
  const [{ count: storylineCount }] = ids.length
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(storylines)
        .where(inArray(storylines.userId, ids))
    : [{ count: 0 }];

  const clerkUsers = (await clerkBackend.users.getUserList({ emailAddress: [normalized] })).data;
  // A row found by email is never a guest — guests have no email — so every
  // clerkId here is set; the filter is for the type, which allows a guest's null.
  const clerkIds = [
    ...new Set([
      ...rows.flatMap((r) => (r.clerkId ? [r.clerkId] : [])),
      ...clerkUsers.map((u) => u.id),
    ]),
  ];

  console.log(`database users: ${rows.length} (${ids.join(', ') || 'none'})`);
  console.log(`storylines:     ${storylineCount}`);
  console.log(`clerk accounts: ${clerkIds.length} (${clerkIds.join(', ') || 'none'})`);

  if (!confirm) {
    console.log('\nDry run. Re-run with --confirm to delete.');
    process.exit(0);
  }

  const purged = await purgeUsersByEmail(normalized);
  console.log(`\ndeleted ${purged.length} database user(s) and everything they owned`);

  for (const clerkId of clerkIds) {
    try {
      await clerkBackend.users.deleteUser(clerkId);
      console.log(`deleted clerk account ${clerkId}`);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) console.log(`clerk account ${clerkId} was already gone`);
      else throw error;
    }
  }

  if (ids.length) {
    console.log(
      `\nStill to do by hand: delete these PostHog persons (People → search → Delete person ` +
        `and data): ${ids.join(', ')}`
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('delete-account failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
