import { randomInt } from 'node:crypto';
import { and, asc, count, eq, gt, gte, isNull, min } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/index';
import { invites } from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import {
  InviteExpiredError,
  InviteUsedError,
  NotFoundError,
  OwnInviteError,
  RateLimitError,
} from '@/lib/utils/errors';
import { isUniqueViolation } from '../guests/guests.claim';
import { createDuet, pickPremise } from '../duets/duets.service';

/**
 * Invites to a story for two (`invites`, `duets`).
 *
 * A player makes one and shares its link (`/invite/<code>`); whoever opens it
 * sees the inviter's first name and, with an account, accepts. Accepting makes
 * the story for two: one side each, each player's next story.
 */

/** Uppercase letters without the ones that look like others: no I, L or O. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
export const INVITE_DAYS = 7;
/** Invites open at once, per player, and made in a day. */
export const MAX_OPEN_INVITES = 5;
export const MAX_INVITES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export const INVITE_URL = 'https://www.brambleworld.com/invite/';

/**
 * A first name as a player gives it: what the other player's story calls them.
 * 16 characters at most, so it fits wherever a premise puts it.
 */
export const firstNameSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(16)
  .regex(/^[\p{L}][\p{L}\p{M}' -]*$/u, 'Letters only');

export function generateCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return code;
}

/** A code as someone typed it: trimmed, any case, never with spaces in it. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

export type CreatedInvite = { code: string; url: string; expiresAt: Date };

export async function createInvite(
  userId: string,
  name: string,
  now = new Date()
): Promise<CreatedInvite> {
  const [open] = await db
    .select({ n: count(), soonest: min(invites.expiresAt) })
    .from(invites)
    .where(
      and(eq(invites.inviterUserId, userId), isNull(invites.acceptedAt), gt(invites.expiresAt, now))
    );
  if (open.n >= MAX_OPEN_INVITES) {
    throw new RateLimitError(secondsUntil(open.soonest, now));
  }
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const [today] = await db
    .select({ n: count(), oldest: min(invites.createdAt) })
    .from(invites)
    .where(and(eq(invites.inviterUserId, userId), gte(invites.createdAt, dayAgo)));
  if (today.n >= MAX_INVITES_PER_DAY) {
    const back = today.oldest ? new Date(today.oldest.getTime() + DAY_MS) : null;
    throw new RateLimitError(secondsUntil(back, now));
  }

  const expiresAt = new Date(now.getTime() + INVITE_DAYS * DAY_MS);
  for (let attempt = 0; ; attempt += 1) {
    const code = generateCode();
    try {
      await db
        .insert(invites)
        .values({ code, inviterUserId: userId, inviterName: name, expiresAt, createdAt: now });
      await track(userId, { name: 'invite_created', properties: {} });
      return { code, url: `${INVITE_URL}${code}`, expiresAt };
    } catch (error) {
      // One in about 150 million per existing code: try another.
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

function secondsUntil(at: Date | null, now: Date): number {
  return Math.max(1, Math.ceil(((at?.getTime() ?? now.getTime() + DAY_MS) - now.getTime()) / 1000));
}

export type InviteState = 'open' | 'accepted' | 'expired';
export type InviteView = { inviterFirstName: string; expiresAt: Date; state: InviteState };

function stateOf(invite: { acceptedAt: Date | null; expiresAt: Date }, now: Date): InviteState {
  if (invite.acceptedAt) return 'accepted';
  return invite.expiresAt <= now ? 'expired' : 'open';
}

export async function readInvite(code: string, now = new Date()): Promise<InviteView> {
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, normalizeCode(code)))
    .orderBy(asc(invites.createdAt))
    .limit(1);
  if (!invite) throw new NotFoundError('Invite');
  return {
    inviterFirstName: invite.inviterName,
    expiresAt: invite.expiresAt,
    state: stateOf(invite, now),
  };
}

/**
 * Accepts an invite and makes the story for two. Once only: accepting again,
 * by the same player, answers with the same duet; by anyone else, it's used.
 */
export async function acceptInvite(
  userId: string,
  code: string,
  name: string,
  now = new Date()
): Promise<{ duetId: string }> {
  const result = await db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(invites)
      .where(eq(invites.code, normalizeCode(code)))
      .for('update');
    if (!invite) throw new NotFoundError('Invite');
    if (invite.inviterUserId === userId) throw new OwnInviteError();
    if (invite.acceptedAt) {
      if (invite.acceptedByUserId === userId && invite.duetId) {
        return { duetId: invite.duetId, created: false };
      }
      throw new InviteUsedError();
    }
    if (invite.expiresAt <= now) throw new InviteExpiredError();

    const premise = await pickPremise(tx, invite.inviterUserId, userId);
    const duetId = await createDuet(
      tx,
      premise,
      { userId: invite.inviterUserId, name: invite.inviterName },
      { userId, name }
    );
    await tx
      .update(invites)
      .set({ acceptedByUserId: userId, acceptedAt: now, duetId, updatedAt: now })
      .where(eq(invites.id, invite.id));
    return { duetId, created: true };
  });

  if (result.created) await track(userId, { name: 'invite_accepted', properties: {} });
  return { duetId: result.duetId };
}
