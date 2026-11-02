/**
 * Sends one test notification to one account, to prove the path through Apple.
 *
 * Production's database is only reachable from inside the cluster, so it runs
 * there from the bundle:
 *
 *   porter app run bramble -- node dist/scripts/send-test-push.js someone@example.com
 *
 * Prints counts and Apple's reasons only, never a token.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { apnsConfigured } from '@/lib/services/push/apns';
import { sendToUser } from '@/lib/services/push/push.service';

async function main() {
  const [email] = process.argv.slice(2);
  if (!email || !email.includes('@')) {
    console.error('usage: send-test-push <email>');
    process.exit(2);
  }
  if (!apnsConfigured()) {
    console.error('APNS_KEY_ID, APNS_PRIVATE_KEY or APPLE_TEAM_ID is not set.');
    process.exit(1);
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!user) {
    console.error('No account with that email.');
    process.exit(1);
  }

  const result = await sendToUser(user.id, {
    title: 'bramble',
    body: 'this is a test notification.',
  });
  console.log(JSON.stringify(result));
  process.exit(result.delivered > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'send-test-push failed');
  process.exit(1);
});
