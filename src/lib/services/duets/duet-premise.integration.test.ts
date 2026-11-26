import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Filling the stock of duet premises against a real database and the fake
 * model: it stops at the stock, writes nothing on a rejection, and what it
 * writes can be given to a pair.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, BRAMBLE_AI_MODE: 'fake' } };
});

const { db } = await import('@/index');
const { duetPremises } = await import('@/db/schema/tables');
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');
const { duetCheckPrompt } = await import('@/lib/ai/prompts/duet.prompt');
const { DUET_PREMISES } = await import('@/lib/duets/seeds');
const { PARTNER, partnerIndex } = await import('@/lib/duets/premise');
const { DUET_PREMISE_STOCK, DUET_PREMISES_PER_RUN, fillDuetPremises } =
  await import('./duet-premise.job');
const { loadPremise, premiseSlugs } = await import('./premises.store');

const pass = async () => ({ flagged: false });
const SEEDS = Object.keys(DUET_PREMISES).length;

function generator(check?: object) {
  const fake = createFakeGenerator();
  registerFixtures(fake);
  if (check) fake.register(duetCheckPrompt, () => check as never);
  return fake;
}

beforeEach(async () => {
  await db.delete(duetPremises);
});
afterAll(async () => {
  await db.delete(duetPremises);
});

describe('filling the stock of duet premises', () => {
  it('writes at most a few a run, and stops once the stock is full', async () => {
    const fake = generator();
    const first = await fillDuetPremises({ generator: fake, safety: pass });
    expect(first).toMatchObject({ written: DUET_PREMISES_PER_RUN, rejected: 0, failed: 0 });

    let runs = 1;
    while ((await premiseSlugs(db)).length < DUET_PREMISE_STOCK && runs < 10) {
      await fillDuetPremises({ generator: fake, safety: pass });
      runs += 1;
    }
    expect(await premiseSlugs(db)).toHaveLength(DUET_PREMISE_STOCK);

    const full = await fillDuetPremises({ generator: fake, safety: pass });
    expect(full).toEqual({ stock: DUET_PREMISE_STOCK, written: 0, rejected: 0, failed: 0 });
  });

  it('writes nothing when the check rejects one, or scores it under the bar', async () => {
    const rejected = await fillDuetPremises({
      generator: generator({ verdict: 'reject', rejectCode: 'romance', qualityScore: 5 }),
      safety: pass,
    });
    expect(rejected).toMatchObject({ written: 0, rejected: DUET_PREMISES_PER_RUN });

    const weak = await fillDuetPremises({
      generator: generator({ verdict: 'pass', rejectCode: null, qualityScore: 3 }),
      safety: pass,
    });
    expect(weak).toMatchObject({ written: 0, rejected: DUET_PREMISES_PER_RUN });
    expect(await db.select().from(duetPremises)).toEqual([]);
  });

  it('writes nothing that moderation flags', async () => {
    const result = await fillDuetPremises({
      generator: generator(),
      safety: async () => ({ flagged: true }),
    });
    expect(result).toMatchObject({ written: 0, rejected: DUET_PREMISES_PER_RUN });
  });

  it('gives what it wrote to pairs, beside the seeds, with the other player as they', async () => {
    await fillDuetPremises({ generator: generator(), safety: pass });
    const slugs = await premiseSlugs(db);
    expect(slugs).toHaveLength(SEEDS + DUET_PREMISES_PER_RUN);
    const written = slugs.find((slug) => slug.startsWith('gen-'))!;
    const premise = (await loadPremise(db, written))!;
    for (const side of [premise.a, premise.b]) {
      expect(side.cast[partnerIndex(side)]).toMatchObject({ name: PARTNER, pronouns: 'they' });
    }
  });

  it('keeps a retired premise loadable for the duets that used it, but gives it to no one', async () => {
    await fillDuetPremises({ generator: generator(), safety: pass });
    const [row] = await db.select().from(duetPremises).limit(1);
    await db.update(duetPremises).set({ status: 'retired' });
    expect(await premiseSlugs(db)).toHaveLength(SEEDS);
    expect(await loadPremise(db, row.slug)).not.toBeNull();
  });
});
