import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';

/**
 * Conversation import, against a real database and a real Redis.
 *
 * Real Redis rather than a fake, deliberately: what most of this file asserts is
 * that a transcript is ciphertext while it rests and gone afterwards, and a fake
 * store would make both true by construction. The generator is forced to the
 * fake through `@/env` so `getGenerator()` still runs its own selection logic —
 * spending real money in a test suite should not be one forgotten mock away.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});

const { db } = await import('@/index');
const { users } = await import('@/db/schema/tables');
const imports = await import('./imports.service');
const reader = await import('./imports.reader');
const writer = await import('./imports.writer');
const { readTranscript, TRANSCRIPT_TTL_SECONDS } = await import('./transcript.store');
const { IMPORT_LIMIT } = await import('./imports.types');
const storylines = await import('../storylines/storylines.service');

const CLERK = 'user_import_owner';

/**
 * A phrase that appears in no fixture and in no prompt. Every assertion about
 * message content reaching a column looks for exactly this, so a leak shows up
 * as this string somewhere it has no business being.
 */
const NEEDLE = 'pomegranate seventeen umbrella';

let userId: string;

/**
 * Whether a worker would pick this import up next.
 *
 * Stands in for what used to be an assertion that a job was enqueued. There is
 * no queue any more — the `queued` row *is* the queue — so "was it enqueued"
 * becomes "is it claimable", which is the same claim about a system with one
 * fewer moving part in it.
 *
 * Claiming is destructive, so these assertions come last in their test.
 */
const claimable = async () => (await writer.claimNextImport(db))?.id ?? null;

function transcriptOf(count = 60) {
  return {
    surface: 'imessage',
    messages: Array.from({ length: count }, (_, i) => ({
      isFromMe: i % 2 === 0,
      handle: i % 2 === 0 ? 'me' : 'c_9b1e04a7d2f3c611',
      sender: i % 2 === 0 ? 'me' : 'Maya',
      text: i === 3 ? NEEDLE : `message number ${i}`,
      sentAt: new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString(),
    })),
  };
}

const request = (key: string, count = 60) => ({
  conversationKey: key,
  transcript: transcriptOf(count),
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
    .values({ clerkId: CLERK, email: 'owner@import.local' })
    .returning({ id: users.id });
  userId = user.id;
});

describe('accepting a conversation', () => {
  it('queues it and holds the transcript, without extracting anything', async () => {
    const result = await imports.requestImport(userId, request('conv_a'));

    expect(result.accepted).toBe(true);
    expect(result.import.status).toBe('queued');
    expect(result.import.storylineId).toBeNull();
    // The row is the queue, so "it was enqueued" means "a worker would take it".
    expect(await claimable()).toBe(result.import.id);
  });

  /**
   * The Mac holds the durable copy and re-sends whenever it is unsure, so a
   * repeat must cost nothing: no second slot, no second job, no second story.
   */
  it('returns the existing import for a conversation already sent', async () => {
    const first = await imports.requestImport(userId, request('conv_a'));
    const again = await imports.requestImport(userId, request('conv_a'));

    expect(again.accepted).toBe(false);
    expect(again.import.id).toBe(first.import.id);
    // One claimable row, not two: a re-send must not give a worker a second copy.
    expect(await claimable()).toBe(first.import.id);
    expect(await claimable()).toBeNull();
  });

  it('re-queues a failed import when the client sends it again', async () => {
    const first = await imports.requestImport(userId, request('conv_a'));
    await writer.markFailed(db, first.import.id, 'TRANSCRIPT_EXPIRED');

    const retry = await imports.requestImport(userId, request('conv_a'));

    expect(retry.accepted).toBe(true);
    expect(retry.import.id).toBe(first.import.id);
    expect(retry.import.status).toBe('queued');
    expect(retry.import.failureCode).toBeNull();
    // Claimable again, which a `failed` row is not — that is the whole point of
    // sending it back to `queued`.
    expect(await claimable()).toBe(first.import.id);
  });
});

describe('the allowance', () => {
  it(`accepts ${IMPORT_LIMIT} conversations and refuses the next`, async () => {
    for (let i = 0; i < IMPORT_LIMIT; i++) {
      await imports.requestImport(userId, request(`conv_${i}`));
    }

    await expect(imports.requestImport(userId, request('conv_one_too_many'))).rejects.toThrow(
      /can import/
    );
  });

  /**
   * Two requests for the last slot. Without the lock both read the same count,
   * both insert, and the reader ends up with four conversations — silently and
   * permanently, since nothing downstream re-checks.
   *
   * Driven by holding the lock rather than by racing two requests and hoping
   * they interleave. A `Promise.all` of two imports passes with the lock removed
   * — the window is narrow enough that they usually serialise anyway — so it
   * proves nothing about the thing it appears to test. This blocks the second
   * request against a lock that is definitely held, which is deterministic.
   */
  it('makes a second request wait for the first to finish counting', async () => {
    for (let i = 0; i < IMPORT_LIMIT - 1; i++) {
      await imports.requestImport(userId, request(`conv_${i}`));
    }

    let release: () => void = () => {};
    const holdUntil = new Promise<void>((resolve) => (release = resolve));

    // One transaction takes the account lock and keeps it.
    const holder = db.transaction(async (tx) => {
      await reader.lockAccount(tx, userId);
      await holdUntil;
    });

    const contender = imports
      .requestImport(userId, request('conv_race'))
      .then(() => 'finished' as const);
    const stillWaiting = new Promise<'waiting'>((resolve) =>
      setTimeout(() => resolve('waiting'), 400)
    );

    // It must not have got past the lock while the holder has it.
    expect(await Promise.race([contender, stillWaiting])).toBe('waiting');
    expect(await reader.countSlotsHeld(db, userId)).toBe(IMPORT_LIMIT - 1);

    release();
    await holder;
    await contender;

    expect(await reader.countSlotsHeld(db, userId)).toBe(IMPORT_LIMIT);
  });

  // And the outcome the lock exists to produce: whichever order they arrive in,
  // the account never ends up holding more than its allowance.
  it('never lets two concurrent requests take the account past the limit', async () => {
    for (let i = 0; i < IMPORT_LIMIT - 1; i++) {
      await imports.requestImport(userId, request(`conv_${i}`));
    }

    await Promise.allSettled([
      imports.requestImport(userId, request('conv_race_a')),
      imports.requestImport(userId, request('conv_race_b')),
    ]);

    expect(await reader.countSlotsHeld(db, userId)).toBe(IMPORT_LIMIT);
  });

  // A failure gives the slot back, which is what lets a reader whose extraction
  // blew up try a different conversation instead.
  it('releases the slot when an import fails', async () => {
    const first = await imports.requestImport(userId, request('conv_a'));
    await imports.requestImport(userId, request('conv_b'));
    await imports.requestImport(userId, request('conv_c'));

    await writer.markFailed(db, first.import.id, 'GENERATION_UNUSABLE');

    await expect(imports.requestImport(userId, request('conv_d'))).resolves.toBeTruthy();
  });

  /**
   * Retrying a failed import bypasses the allowance for its own row, or a reader
   * whose third conversation failed could never send it again. The rest of the
   * account still counts, so the bypass cannot be used to exceed the limit —
   * which is a real hole if the two are not checked together.
   */
  it('refuses a retry that would take the account past the limit', async () => {
    const first = await imports.requestImport(userId, request('conv_a'));
    await imports.requestImport(userId, request('conv_b'));
    await writer.markFailed(db, first.import.id, 'GENERATION_FAILED');

    // The freed slot goes to a different conversation.
    await imports.requestImport(userId, request('conv_c'));
    await imports.requestImport(userId, request('conv_d'));

    await expect(imports.requestImport(userId, request('conv_a'))).rejects.toThrow(/can import/);
  });

  it('reports used slots as ready imports only', async () => {
    const a = await imports.requestImport(userId, request('conv_a'));
    await imports.requestImport(userId, request('conv_b'));

    const storyline = await storylines.createStoryline(userId, {
      title: 'x',
      sourceSurface: 'imessage',
    });
    await writer.markReady(db, a.import.id, storyline.id);

    const allowance = await imports.allowanceFor(userId);
    expect(allowance).toMatchObject({ limit: IMPORT_LIMIT, used: 1 });
    expect(allowance.imports).toHaveLength(2);
  });
});

describe('validation', () => {
  it('refuses a conversation too short to be worth extracting', async () => {
    await expect(imports.requestImport(userId, request('conv_a', 10))).rejects.toThrow(/at least/);
  });

  it('refuses a transcript past the character ceiling', async () => {
    const big = request('conv_a');
    big.transcript.messages[0].text = 'x'.repeat(400_001);

    await expect(imports.requestImport(userId, big)).rejects.toThrow(/ceiling/);
  });

  it('refuses messages that are not oldest first', async () => {
    const jumbled = request('conv_a');
    jumbled.transcript.messages[5].sentAt = '2020-01-01T00:00:00.000Z';

    await expect(imports.requestImport(userId, jumbled)).rejects.toThrow(/oldest first/);
  });
});

describe('what reaches Redis', () => {
  it('holds the transcript as ciphertext, with an expiry set', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));

    const Redis = (await import('ioredis')).default;
    const client = new Redis(process.env.REDIS_URL!);
    const raw = await client.get(`import:${row.id}`);
    const ttl = await client.ttl(`import:${row.id}`);
    await client.quit();

    expect(raw).not.toBeNull();
    // The whole point. A Redis dump is this string and nothing else.
    expect(raw).not.toContain(NEEDLE);
    expect(raw).not.toContain('Maya');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TRANSCRIPT_TTL_SECONDS);
  });

  it('reads back exactly what was sent', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    const back = await readTranscript(row.id, userId);

    expect(back?.messages[3].text).toBe(NEEDLE);
  });

  // The associated data binds a blob to its import and account, so a transcript
  // cannot be replayed into a different one.
  it('will not read another account transcript', async () => {
    const { import: row } = await imports.requestImport(userId, request('conv_a'));
    const stranger = '00000000-0000-4000-8000-000000000000';

    await expect(readTranscript(row.id, stranger)).rejects.toThrow();
  });
});
