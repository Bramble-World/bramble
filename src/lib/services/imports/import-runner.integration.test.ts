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
const {
  imports: importsTable,
  storylines: storylineTable,
  users,
} = await import('@/db/schema/tables');
const imports = await import('./imports.service');
const reader = await import('./imports.reader');
const writer = await import('./imports.writer');
const { MAX_IMPORT_ATTEMPTS } = await import('./imports.types');
const { runImport, sweepStalledImports } = await import('./import-runner');
const { dropTranscript, readTranscript } = await import('./transcript.store');
const storylines = await import('../storylines/storylines.service');

const CLERK = 'user_runner_owner';
const NEEDLE = 'pomegranate seventeen umbrella';

let userId: string;

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
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

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
   * A reclaimed stale row means two attempts can overlap. Extraction
   * is a model call and a storyline write — the last things that should happen
   * twice.
   */
  it('lets only one attempt claim an import', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

    const [first, second] = await Promise.all([runImport(row.id), runImport(row.id)]);
    const outcomes = [first.status, second.status].sort();

    expect(outcomes).toStrictEqual(['ready', 'skipped']);
  });

  it('does nothing to an import that is already ready', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
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
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
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
   * is a re-send rather than a loss.
   *
   * It goes back to `queued`, which is the fix for a bug the old queue had: the
   * row was marked `failed` and the error rethrown for the queue to retry, but
   * `failed` is not claimable — so every retry after the first found a failed
   * row, declined to claim it, and recorded a successful no-op. The retries
   * never ran at all.
   */
  it('requeues for another attempt when the transcript is gone', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    await dropTranscript(row.id);

    expect(await runImport(row.id)).toStrictEqual({ status: 'retrying' });

    const after = await reader.getImport(userId, row.id);
    // Claimable again, rather than failed — and carrying no failure code, since
    // the client branches on status and this import is still going to run.
    expect(after?.status).toBe('queued');
    expect(after?.failureCode).toBeNull();
  });

  /**
   * The retry budget, which lives on the row rather than in the worker: the
   * attempt that gives up is rarely the attempt that started, and a budget held
   * in memory resets on exactly the crash it is meant to bound.
   */
  it('gives up after three attempts and fails terminally', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    await dropTranscript(row.id);

    const outcomes: string[] = [];
    for (let i = 0; i < MAX_IMPORT_ATTEMPTS; i++) {
      // The backoff would otherwise make the next claim wait seconds. Clearing it
      // tests the attempt count rather than the clock, which is tested below.
      await db.update(importsTable).set({ nextAttemptAt: null }).where(eq(importsTable.id, row.id));
      outcomes.push((await runImport(row.id)).status);
    }

    expect(outcomes).toStrictEqual(['retrying', 'retrying', 'failed']);

    const after = await reader.getImport(userId, row.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureCode).toBe('TRANSCRIPT_EXPIRED');

    // And it stays failed: a fourth run must not find it claimable.
    expect(await runImport(row.id)).toStrictEqual({ status: 'skipped' });
  });

  /**
   * Backoff is the entire point of retrying a busy upstream. A requeued row is
   * claimable the instant it is written, so without a delay the three attempts
   * are spent as fast as three calls can fail.
   */
  it('holds a requeued import back until its backoff has passed', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    await dropTranscript(row.id);
    await runImport(row.id);

    const [waiting] = await db
      .select({ nextAttemptAt: importsTable.nextAttemptAt, attempts: importsTable.attempts })
      .from(importsTable)
      .where(eq(importsTable.id, row.id));

    expect(waiting.attempts).toBe(1);
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // Queued, and still not claimable — which is the distinction that matters.
    expect(await writer.claimNextImport(db)).toBeNull();
  });

  /**
   * A re-send resets the budget. Without this an import that spent its three
   * attempts could never run again, however many times the client handed it back.
   */
  it('gives a re-sent import a fresh budget', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    await dropTranscript(row.id);
    for (let i = 0; i < MAX_IMPORT_ATTEMPTS; i++) {
      await db.update(importsTable).set({ nextAttemptAt: null }).where(eq(importsTable.id, row.id));
      await runImport(row.id);
    }
    expect((await reader.getImport(userId, row.id))?.status).toBe('failed');

    const again = await imports.requestImport(userId, request('conv_a'));

    expect(again.accepted).toBe(true);
    expect(await runImport(again.import.id)).toMatchObject({ status: 'ready' });
  });

  it('skips an import that no longer exists', async () => {
    expect(await runImport('00000000-0000-4000-8000-000000000000')).toStrictEqual({
      status: 'skipped',
    });
  });
});

/**
 * The claim, under concurrency.
 *
 * This is the one guarantee the whole worker design rests on: N processes, each
 * polling the same table every two seconds, and never two of them on the same
 * import. Extraction is a model call and a storyline write, so losing this means
 * paying twice and handing the reader the same conversation twice.
 */
describe('claiming the next import', () => {
  it('gives one import to exactly one of many simultaneous workers', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

    // Eight at once, which is more workers than this will ever run with — the
    // point is to lose by a wide margin if the claim is not atomic.
    const claims = await Promise.all(Array.from({ length: 8 }, () => writer.claimNextImport(db)));

    expect(claims.filter((c) => c !== null)).toStrictEqual([{ id: row.id, userId, attempts: 1 }]);
  });

  /**
   * `skip locked` rather than plain `for update`: every idle worker would
   * otherwise queue on the same oldest row and all but one would throw its round
   * trip away. Here each one is handed a different import.
   */
  it('hands simultaneous workers different imports rather than queueing them', async () => {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      rows.push((await imports.requestImport(userId, request(`conv_${i}`))).import.id);
    }

    const claims = await Promise.all(Array.from({ length: 6 }, () => writer.claimNextImport(db)));
    const claimed = claims.filter((c) => c !== null).map((c) => c!.id);

    expect(claimed).toHaveLength(3);
    expect(new Set(claimed)).toStrictEqual(new Set(rows));
  });

  it('counts the attempt on the row, so the budget survives the worker', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

    const first = await writer.claimNextImport(db);
    // Reclaimable only once stale, so this is the by-id claim forcing a second
    // attempt — which is what a crashed worker's row gets.
    await db
      .update(importsTable)
      .set({ startedAt: new Date(Date.now() - writer.RUN_RECLAIM_AFTER_MS - 1_000) })
      .where(eq(importsTable.id, row.id));
    const second = await writer.claimImport(db, row.id);

    expect(first?.attempts).toBe(1);
    expect(second).toBe(2);
  });

  it('will not claim an import that has spent its attempts', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    await db
      .update(importsTable)
      .set({ attempts: MAX_IMPORT_ATTEMPTS })
      .where(eq(importsTable.id, row.id));

    expect(await writer.claimNextImport(db)).toBeNull();
    expect(await writer.claimImport(db, row.id)).toBeNull();
  });

  it('finds nothing when there is nothing queued', async () => {
    expect(await writer.claimNextImport(db)).toBeNull();
  });
});

describe('the stall sweep', () => {
  /**
   * A dropped job — a deploy mid-run, an exhausted retry budget — otherwise
   * leaves the reader watching a spinner forever and a slot reserved against
   * work that will never happen.
   */
  it('fails imports older than the transcript is held', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

    const result = await sweepStalledImports(-1);

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const after = await reader.getImport(userId, row.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureCode).toBe('TRANSCRIPT_EXPIRED');
  });

  it('leaves a fresh import alone', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

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
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
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
