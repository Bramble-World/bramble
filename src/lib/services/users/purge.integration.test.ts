import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/index';
import { imports, users } from '@/db/schema/tables';
import { createFakeGenerator } from '@/lib/ai';
import { registerFixtures } from '@/lib/ai/fixtures';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as sessions from '../sessions/sessions.service';
import * as timeline from '../timeline/timeline.service';
import * as motifs from '../motifs/motifs.service';
import { generateTurn } from '../generation/turns.service';
import { purgeUsersByEmail } from './users.writer';

/**
 * "Email us and we delete your account" (privacy policy) rests on one claim:
 * deleting the `users` row leaves nothing of that person behind. That's only
 * true while every table cascades from it, and a new table with a missing
 * `onDelete` would break it silently. So this builds an account that touches
 * every kind of row, purges it, and then asks the schema itself, not a list
 * written here, which tables could still hold it.
 */
const OWNER = { clerkId: 'user_purge_owner', email: 'Owner@Purge.local' };
const BYSTANDER = { clerkId: 'user_purge_bystander', email: 'bystander@purge.local' };

let ownerId: string;
let bystanderId: string;
let ownerStorylineIds: string[] = [];

async function makeAccount(clerkId: string, email: string) {
  const [user] = await db
    .insert(users)
    .values({ clerkId, email: email.toLowerCase() })
    .returning({ id: users.id });
  const userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'The Unsent Apology',
    sourceSurface: 'imessage',
    tone: 'wistful',
  });
  await storylines.markStatus(userId, storyline.id, 'ready');

  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  const maya = await persons.getOrCreatePersonByHandle(userId, 'c_0123456789abcdef', 'Maya');
  const a = await storylines.castCharacter(userId, storyline.id, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storyline.id, maya.id);
  await storylines.relateCharacters(userId, storyline.id, a.id, b.id, { closeness: 'was close' });
  await timeline.appendEvent(userId, storyline.id, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in three weeks.',
    participantCharacterIds: [a.id, b.id],
  });
  await timeline.appendEvent(userId, storyline.id, {
    origin: 'extracted',
    title: 'The message',
    description: 'One of them finally typed something.',
  });
  await motifs.createMotif(userId, { label: 'the lasagna incident' }, [self.id, maya.id]);
  await db
    .insert(imports)
    .values({ userId, conversationKey: 'conv-purge', storylineId: storyline.id });

  const fake = createFakeGenerator();
  registerFixtures(fake);
  const session = await sessions.startSession(userId, storyline.id);
  await generateTurn(userId, session.id, { generator: fake });

  return { userId, storylineId: storyline.id };
}

/** Every public table with a column of this name, read from the live schema. */
async function tablesWithColumn(column: string): Promise<string[]> {
  const result = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = ${column}
  `);
  return result.rows.map((r) => r.table_name);
}

async function rowsWhere(table: string, column: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    )})`
  );
  return result.rows[0].n;
}

beforeAll(async () => {
  await db.delete(users).where(eq(users.clerkId, OWNER.clerkId));
  await db.delete(users).where(eq(users.clerkId, BYSTANDER.clerkId));
  const owner = await makeAccount(OWNER.clerkId, OWNER.email);
  const bystander = await makeAccount(BYSTANDER.clerkId, BYSTANDER.email);
  ownerId = owner.userId;
  bystanderId = bystander.userId;
  ownerStorylineIds = [owner.storylineId];
});

afterAll(async () => {
  await db.delete(users).where(eq(users.clerkId, OWNER.clerkId));
  await db.delete(users).where(eq(users.clerkId, BYSTANDER.clerkId));
});

describe('purgeUsersByEmail', () => {
  it('deletes the account and every row it owned, in every table', async () => {
    const userTables = await tablesWithColumn('user_id');
    const storylineTables = await tablesWithColumn('storyline_id');
    // The scan is only meaningful if the account really did touch these tables.
    let before = 0;
    for (const table of userTables) before += await rowsWhere(table, 'user_id', [ownerId]);
    expect(before).toBeGreaterThan(5);

    // Matched case-insensitively, as every writer stores email lowercased.
    const purged = await purgeUsersByEmail('  OWNER@purge.LOCAL ');
    expect(purged).toEqual([{ id: ownerId, clerkId: OWNER.clerkId }]);

    expect(await rowsWhere('users', 'id', [ownerId])).toBe(0);
    for (const table of userTables) {
      expect({ table, rows: await rowsWhere(table, 'user_id', [ownerId]) }).toEqual({
        table,
        rows: 0,
      });
    }
    for (const table of storylineTables) {
      expect({ table, rows: await rowsWhere(table, 'storyline_id', ownerStorylineIds) }).toEqual({
        table,
        rows: 0,
      });
    }
  });

  it("leaves everyone else's data alone", async () => {
    expect(await rowsWhere('users', 'id', [bystanderId])).toBe(1);
    expect(await rowsWhere('storylines', 'user_id', [bystanderId])).toBe(1);
  });

  it('is a no-op for an email with no account', async () => {
    expect(await purgeUsersByEmail('nobody@purge.local')).toEqual([]);
  });
});
