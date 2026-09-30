import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

/**
 * The extraction worker, against a real database, a real Redis and the fake
 * generator.
 *
 * The last test in this file is the one that matters most: it scans every column
 * of every table for a phrase that only ever existed in a message, and asserts
 * it is nowhere. invariants.md §1 calls a breach of that "identical to correct
 * data" — nothing else in the system would notice.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});

const { db } = await import('@/index');
const { storylines: storylineTable, users } = await import('@/db/schema/tables');
const imports = await import('./imports.service');
const reader = await import('./imports.reader');
const writer = await import('./imports.writer');
const { runImport, sweepStalledImports } = await import('./import-runner');
const { dropTranscript, readTranscript } = await import('./transcript.store');
const storylines = await import('../storylines/storylines.service');

const CLERK = 'user_runner_owner';
const NEEDLE = 'pomegranate seventeen umbrella';

let userId: string;
const noop = async () => {};

const request = (key: string) => ({
  conversationKey: key,
  transcript: {
    surface: 'imessage',
    messages: Array.from({ length: 60 }, (_, i) => ({
      isFromMe: i % 2 === 0,
      handle: i % 2 === 0 ? 'me' : 'c_9b1e04a7d2f3c611',
      sender: i % 2 === 0 ? 'me' : 'Maya',
      text: i === 3 ? NEEDLE : `message number ${i}`,
      sentAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
    })),
  },
});

beforeAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

afterAll(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
});

beforeEach(async () => {
  await db.delete(users).where(like(users.clerkId, `${CLERK}%`));
  const [user] = await db
    .insert(users)
    .values({ clerkId: CLERK, email: 'owner@runner.local' })
    .returning({ id: users.id });
  userId = user.id;
});

describe('running an import', () => {
  it('turns a held transcript into a storyline and lets the ciphertext go', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);

    const outcome = await runImport(row.id);

    expect(outcome.status).toBe('ready');
    expect(outcome.storylineId).toEqual(expect.any(String));

    const after = await reader.getImport(userId, row.id);
    expect(after?.status).toBe('ready');
    expect(after?.storylineId).toBe(outcome.storylineId);
    expect(after?.stage).toBeNull();

    // Deleted the moment it is no longer needed, rather than left to expire.
    expect(await readTranscript(row.id, userId)).toBeNull();
  });

  /**
   * Trigger.dev delivers at least once, so two attempts can overlap. Extraction
   * is a model call and a storyline write — the last things that should happen
   * twice.
   */
  it('lets only one attempt claim an import', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);

    const [first, second] = await Promise.all([runImport(row.id), runImport(row.id)]);
    const outcomes = [first.status, second.status].sort();

    expect(outcomes).toStrictEqual(['ready', 'skipped']);
  });

  it('does nothing to an import that is already ready', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);
    const first = await runImport(row.id);

    const again = await runImport(row.id);

    expect(again).toStrictEqual({ status: 'ready', storylineId: first.storylineId });
  });

  /**
   * A crash between writing the storyline and marking the import ready. The
   * retry must adopt what exists rather than pay for a second extraction and
   * leave the reader with the same conversation twice.
   */
  it('adopts a storyline a previous attempt already finished', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);
    const storyline = await storylines.createStoryline(userId, {
      title: 'Written by an attempt that died',
      sourceSurface: 'imessage',
    });
    await storylines.markStatus(userId, storyline.id, 'ready');
    await writer.attachStoryline(db, row.id, storyline.id);

    const countStorylines = async () => {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(storylineTable)
        .where(eq(storylineTable.userId, userId));
      return r.n;
    };
    const before = await countStorylines();

    const outcome = await runImport(row.id);

    expect(outcome).toStrictEqual({ status: 'ready', storylineId: storyline.id });
    // No second storyline, and no second model call behind it.
    expect(await countStorylines()).toBe(before);
  });

  /**
   * Expired, evicted, or never written. The Mac holds the durable copy, so this
   * is a re-send rather than a loss — and it is rethrown so the queue schedules
   * a retry instead of recording a run that quietly failed.
   */
  it('fails retryably when the transcript is gone', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);
    await dropTranscript(row.id);

    await expect(runImport(row.id)).rejects.toThrow();

    const after = await reader.getImport(userId, row.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureCode).toBe('TRANSCRIPT_EXPIRED');
  });

  it('skips an import that no longer exists', async () => {
    expect(await runImport('00000000-0000-4000-8000-000000000000')).toStrictEqual({
      status: 'skipped',
    });
  });
});

describe('the stall sweep', () => {
  /**
   * A dropped job — a deploy mid-run, an exhausted retry budget — otherwise
   * leaves the reader watching a spinner forever and a slot reserved against
   * work that will never happen.
   */
  it('fails imports older than the transcript is held', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);

    const result = await sweepStalledImports(-1);

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const after = await reader.getImport(userId, row.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureCode).toBe('TRANSCRIPT_EXPIRED');
  });

  it('leaves a fresh import alone', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);

    await sweepStalledImports(30 * 60 * 1000);

    expect((await reader.getImport(userId, row.id))?.status).toBe('queued');
  });
});

/**
 * invariants.md §1, asserted rather than trusted.
 *
 * "Messages never reach a long-term store" is the product's central claim and a
 * breach of it looks exactly like correct data — the rows would be valid, the
 * app would work, and nothing would ever report it. So this scans every column
 * of every table in the schema rather than the handful anyone would think to
 * check.
 */
describe('message content never reaches Postgres', () => {
  it('is nowhere in any column of any table, after a full extraction', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'), noop);
    const outcome = await runImport(row.id);
    expect(outcome.status).toBe('ready');

    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `);

    const hits: string[] = [];
    for (const { table_name } of tables.rows) {
      const found = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table_name)} t
            where to_jsonb(t)::text like ${'%' + NEEDLE + '%'}`
      );
      if ((found.rows[0]?.n ?? 0) > 0) hits.push(table_name);
    }

    expect(hits).toStrictEqual([]);
    // And the scan itself is not vacuous — it finds the needle when it is there.
    const control = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from (select ${NEEDLE}::text as x) t
          where to_jsonb(t)::text like ${'%' + NEEDLE + '%'}`
    );
    expect(control.rows[0].n).toBe(1);
  });
});
