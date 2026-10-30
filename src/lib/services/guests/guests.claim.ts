import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/index';
import {
  characters,
  imports,
  motifParticipants,
  motifs,
  personRelationships,
  persons,
  storylineSessions,
  storylines,
  users,
} from '@/db/schema/tables';
import { ConflictError, ForbiddenError, UnauthorizedError } from '@/lib/utils/errors';
import { track, trackAlias } from '@/lib/analytics/analytics';
import * as userReader from '../users/users.reader';
import { ClerkIdentity } from '../users/users.identity';
import { Executor } from '../executor';

/**
 * Signing up from a guest: the guest's story becomes an account's.
 *
 * Two outcomes, decided by whether the Clerk user already has a row:
 *
 * - **A new account.** The guest's own row becomes the account — it gains a
 *   Clerk id and an email and stops being a guest. Nothing moves, so nothing can
 *   be lost in moving it, and the user id the app has been sending to PostHog
 *   since the first screen is still the user id.
 * - **An existing account.** The guest's story moves into it in one transaction
 *   and the guest row is deleted. The account's world gains the story; the two
 *   "you"s become one.
 *
 * Either way the guest token stops working at once, because it is checked
 * against a row that is no longer a guest, or no longer there.
 */

/**
 * Every table that carries a `user_id` directly, and so must be re-pointed when a
 * guest's story moves into an account.
 *
 * Everything else hangs off one of these — characters off storylines, turns off
 * sessions — and moves with its parent without being touched. A test reads the
 * live schema and fails if a table with `user_id` is added and not listed here,
 * because a missed table would be rows silently left on a guest that is about to
 * be deleted, taking them with it.
 */
export const USER_OWNED_TABLES = [
  persons,
  personRelationships,
  storylines,
  motifs,
  storylineSessions,
  imports,
] as const;

export type ClaimMethod = 'apple' | 'passkey' | 'email';

/**
 * Attaches a guest to a Clerk identity.
 *
 * `fetchIdentity` is called only when a new account is being made, and is a
 * callback for the same reason it is in `getOrCreateFromClerk`: this layer
 * knows nothing about Clerk beyond its user id.
 *
 * **The Clerk webhook can race this**, because a brand-new Clerk account fires
 * `user.created` at about the moment the app sends this request. If the webhook
 * lands first, the account row exists and this merges into it. If this lands
 * first, the guest row already carries the clerk id and the webhook's insert is
 * a no-op. And if the webhook commits in the instant between this reading "no
 * account" and writing the clerk id, the write hits the unique index, and this
 * re-reads and merges after all.
 */
export async function claimGuest(input: {
  guestId: string;
  clerkId: string;
  fetchIdentity: () => Promise<ClerkIdentity>;
  method?: ClaimMethod;
}): Promise<{ merged: boolean; userId: string }> {
  const { guestId, clerkId } = input;

  let account = await userReader.getUserByClerkId(clerkId);

  if (!account) {
    const identity = await input.fetchIdentity();
    try {
      await becomeAccount(guestId, clerkId, identity);
      await reportSignup(guestId, { merged: false, method: input.method });
      return { merged: false, userId: guestId };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // The write lost to a row that already holds this clerk id or this email.
      account = await userReader.getUserByClerkId(clerkId);
      if (!account) {
        const anyRow = await userReader.getUserByClerkIdIncludingDeleted(clerkId);
        if (anyRow?.deletedAt) throw new ForbiddenError('This account has been deleted');
        throw new ConflictError(`${identity.email} is already registered`);
      }
    }
  }

  await mergeInto(guestId, account.id);
  await trackAlias(account.id, guestId);
  await reportSignup(account.id, { merged: true, method: input.method });
  return { merged: true, userId: account.id };
}

async function reportSignup(
  userId: string,
  props: { merged: boolean; method?: ClaimMethod }
): Promise<void> {
  await track(userId, {
    name: 'signup_completed',
    properties: { merged: props.merged, ...(props.method ? { method: props.method } : {}) },
  });
}

/**
 * The live guest row, locked for the rest of the transaction — or a 401.
 *
 * The lock is what makes a claim happen once: two claims of one guest (a double
 * tap, a retry racing its original) serialise here, and the second finds a row
 * that is no longer a guest, or no longer there. Exactly the answer its token
 * would get on any other route.
 */
async function lockLiveGuest(tx: Executor, guestId: string): Promise<void> {
  const [guest] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, guestId),
        eq(users.isGuest, true),
        isNull(users.deletedAt),
        gt(users.guestExpiresAt, sql`now()`)
      )
    )
    .for('update');
  if (!guest) throw new UnauthorizedError();
}

/** The new-account path: the guest row gains the identity and stops being a guest. */
async function becomeAccount(
  guestId: string,
  clerkId: string,
  identity: ClerkIdentity
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLiveGuest(tx, guestId);
    await tx
      .update(users)
      .set({
        clerkId,
        // Lowercased, as every writer of this column does: the partial unique
        // index on it is case-sensitive.
        email: identity.email.toLowerCase(),
        emailVerifiedAt: identity.verified ? new Date() : null,
        isGuest: false,
        guestExpiresAt: null,
        // Only ever needed to limit live guests. An account has no use for it.
        appAttestKeyId: null,
      })
      .where(eq(users.id, guestId));
  });
}

/**
 * The existing-account path: everything the guest owns moves to the account, the
 * two self persons become one, and the guest row is deleted.
 *
 * One transaction, because every intermediate state is wrong in a way that reads
 * as valid: a storyline moved without its people, or two `isSelf` persons on one
 * account (which the one-self index refuses, so the order below matters).
 */
async function mergeInto(guestId: string, accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLiveGuest(tx, guestId);

    const selfOf = async (userId: string) =>
      (
        await tx
          .select({ id: persons.id })
          .from(persons)
          .where(and(eq(persons.userId, userId), eq(persons.isSelf, true)))
      )[0];
    const guestSelf = await selfOf(guestId);
    const accountSelf = await selfOf(accountId);

    // First, while the guest's self is still the guest's: fold it into the
    // account's. If the account has none, the guest's simply moves with the
    // rest below and becomes the account's self — still exactly one.
    if (guestSelf && accountSelf) {
      await mergeSelf(tx, guestId, guestSelf.id, accountSelf.id);
    }

    for (const table of USER_OWNED_TABLES) {
      await tx.update(table).set({ userId: accountId }).where(eq(table.userId, guestId));
    }

    // Everything it owned has moved, so this deletes the row and nothing else.
    await tx.delete(users).where(eq(users.id, guestId));
  });
}

/**
 * Makes the account's self person stand wherever the guest's stood, then
 * deletes the guest's.
 *
 * Three places hold a person id: characters (who plays "you" in each story),
 * motif participants, and person relationships. Turn surfaces hold person ids
 * too, but only of senders, and a sender is never the reader.
 */
async function mergeSelf(
  tx: Executor,
  guestId: string,
  guestSelfId: string,
  accountSelfId: string
): Promise<void> {
  // A storyline casts a person at most once, and the guest's storylines cast
  // only the guest's people, so the account's self is never already there.
  await tx
    .update(characters)
    .set({ personId: accountSelfId })
    .where(eq(characters.personId, guestSelfId));

  // Re-pointed by insert-then-delete rather than update, so a motif the account
  // already shares with itself — impossible today, cheap to be safe about — is
  // deduplicated by the primary key rather than violating it.
  const motifRows = await tx
    .select({ motifId: motifParticipants.motifId })
    .from(motifParticipants)
    .where(eq(motifParticipants.personId, guestSelfId));
  if (motifRows.length) {
    await tx
      .insert(motifParticipants)
      .values(motifRows.map((row) => ({ motifId: row.motifId, personId: accountSelfId })))
      .onConflictDoNothing();
  }

  // Each relationship is re-sorted, because swapping one end can flip which id
  // is lower and the CHECK (a < b) would refuse it; and deduplicated on the
  // pair, which the unique index would otherwise refuse.
  const relationships = await tx
    .select({
      id: personRelationships.id,
      a: personRelationships.personAId,
      b: personRelationships.personBId,
      relationshipType: personRelationships.relationshipType,
    })
    .from(personRelationships)
    .where(
      and(
        eq(personRelationships.userId, guestId),
        sql`${guestSelfId} IN (${personRelationships.personAId}, ${personRelationships.personBId})`
      )
    );
  for (const relationship of relationships) {
    const other = relationship.a === guestSelfId ? relationship.b : relationship.a;
    const [a, b] = [accountSelfId, other].sort();
    await tx
      .insert(personRelationships)
      .values({
        userId: guestId, // moved with the rest of the guest's rows in a moment
        personAId: a,
        personBId: b,
        relationshipType: relationship.relationshipType,
      })
      .onConflictDoNothing();
  }

  // Its relationships and motif rows cascade with it; every one was copied above.
  await tx.delete(persons).where(eq(persons.id, guestSelfId));
}

/**
 * Whether a database error is a unique-index violation (SQLSTATE 23505).
 *
 * Walks the `cause` chain, because drizzle wraps the driver's error in its own
 * "Failed query" error and the code is only on the original.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
