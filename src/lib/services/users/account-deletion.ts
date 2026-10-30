import * as Sentry from '@sentry/nextjs';
import { eq } from 'drizzle-orm';
import { db } from '@/index';
import { users } from '@/db/schema/tables';
import { clerkBackend } from '@/lib/services/auth/auth.client';
import { exchangeAppleCode, revokeAppleToken } from '@/lib/services/auth/apple-sign-in';
import { deleteAnalyticsPerson } from '@/lib/analytics/person-deletion';
import { PublicUser } from './users.types';
import { ReverificationRequiredError } from '@/lib/utils/errors';

/**
 * Deletes a player's account from inside the app, straight away.
 *
 * Replaces deletion by email for anyone who can still sign in (the script in
 * src/scripts/delete-account.ts stays for those who can't). Four things go:
 *
 * 1. their Sign in with Apple, revoked at Apple, when the account has Apple;
 * 2. their PostHog person and every event it sent;
 * 3. every row they own — the `users` row, and everything cascading from it;
 * 4. their Clerk user, with its passkeys and sessions.
 *
 * **Proof first, then the irreversible steps, the one that matters most last.**
 * Nothing is deleted until the player has proved it's them, so a failure there
 * leaves everything as it was. The rows and the Clerk user go together in one
 * transaction — Clerk's delete runs inside it, so if Clerk refuses, the rows
 * roll back and the account is whole. Apple and PostHog go before it because
 * they're the ones a retry can repeat harmlessly: revoking is idempotent from
 * the player's side, and deleting a deleted person deletes nothing.
 */

/** How recent a sign-in must be to delete an account. */
export const REVERIFY_WITHIN_MINUTES = 10;

/** Clerk's provider names for Apple: `oauth_apple` today, `apple` in places. */
const APPLE_PROVIDERS = new Set(['oauth_apple', 'apple']);

export interface DeletionProof {
  /** From the session token: minutes since the last first-factor check. */
  firstFactorAgeMinutes: number | null;
  /** From a fresh Sign in with Apple, for an account with Apple on it. */
  appleAuthorizationCode?: string;
}

export async function deleteAccount(user: PublicUser, proof: DeletionProof): Promise<void> {
  // withAccount has refused guests, so there is a Clerk id.
  const clerkId = user.clerkId!;

  const clerkUser = await clerkBackend.users.getUser(clerkId);
  const apple = clerkUser.externalAccounts.find((a) => APPLE_PROVIDERS.has(a.provider));

  // An account with Apple confirms with Apple: Clerk can't re-verify with Apple,
  // and the fresh code is also the only way to get a token to revoke. Anyone
  // else confirms through Clerk — a passkey or an email code — within minutes.
  let appleRefreshToken: string | null = null;
  if (apple) {
    if (!proof.appleAuthorizationCode) {
      throw new ReverificationRequiredError('Sign in with Apple to confirm, then try again.');
    }
    const exchanged = await exchangeAppleCode(proof.appleAuthorizationCode);
    if (exchanged.appleUserId !== apple.providerUserId) {
      throw new ReverificationRequiredError(
        'That Apple ID is not the one on this account. Sign in with the right one.'
      );
    }
    appleRefreshToken = exchanged.refreshToken;
  } else if (
    proof.firstFactorAgeMinutes === null ||
    proof.firstFactorAgeMinutes > REVERIFY_WITHIN_MINUTES
  ) {
    throw new ReverificationRequiredError();
  }

  try {
    if (appleRefreshToken) await revokeAppleToken(appleRefreshToken);
    await deleteAnalyticsPerson(user.id);

    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, user.id));
      try {
        await clerkBackend.users.deleteUser(clerkId);
      } catch (error) {
        // Already gone in Clerk is the outcome we want, not a reason to keep the rows.
        if ((error as { status?: number }).status !== 404) throw error;
      }
    });
  } catch (error) {
    // Structural only: ids, never the email. handleError doesn't report AppErrors,
    // and a deletion that fails is one somebody has to finish by hand.
    Sentry.captureException(error, {
      tags: { flow: 'account_deletion' },
      extra: { userId: user.id },
    });
    console.error('account deletion failed', {
      userId: user.id,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
}
