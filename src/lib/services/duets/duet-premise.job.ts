import { randomBytes } from 'node:crypto';
import { db } from '@/index';
import { duetPremises } from '@/db/schema/tables';
import { Generator, getGenerator } from '@/lib/ai';
import {
  DUET_QUALITY_BAR,
  duetCheckPrompt,
  duetWritePrompt,
  PAIRINGS,
} from '@/lib/ai/prompts/duet.prompt';
import {
  duetPremiseSchema,
  premiseProblem,
  withPartnerAsThey,
  type DuetPremise,
} from '@/lib/duets/premise';
import { getSafetyCheck, type SafetyCheck } from '@/lib/onboarding/safety';
import { templateText } from '@/lib/pool/template';
import { premiseSlugs, premiseSummaries } from './premises.store';

/** Premises kept ready, seeds included: enough that a pair rarely repeats one. */
export const DUET_PREMISE_STOCK = 10;
/** The most written in one run, so a run's cost has a ceiling even when every one is rejected. */
export const DUET_PREMISES_PER_RUN = 3;

export type PremiseOutcome = 'ready' | 'rejected' | 'failed';

export type DuetPremiseDeps = {
  generator?: Generator;
  safety?: SafetyCheck;
  random?: () => number;
};

/**
 * Writes one premise and keeps it if it passes: the writer, the rules the
 * schema can't hold, the check (which may reject, and scores it), then
 * moderation on everything that would be played. Only a pass is written to
 * `duet_premises`; a rejection writes nothing and costs nothing more.
 */
export async function writeDuetPremise(deps: DuetPremiseDeps = {}): Promise<PremiseOutcome> {
  const generator = deps.generator ?? getGenerator();
  const safety = deps.safety ?? getSafetyCheck();
  const random = deps.random ?? Math.random;
  try {
    const pairing = PAIRINGS[Math.floor(random() * PAIRINGS.length)];
    const existing = await premiseSummaries(db);
    const { value } = await generator.run(duetWritePrompt, { pairing, existing });

    const parsed = duetPremiseSchema.safeParse(value);
    if (!parsed.success) return 'rejected';
    const premise: DuetPremise = withPartnerAsThey(parsed.data);
    if (premiseProblem(premise)) return 'rejected';

    const { value: checked } = await generator.run(duetCheckPrompt, { premise });
    if (checked.verdict === 'reject' || checked.qualityScore < DUET_QUALITY_BAR) return 'rejected';

    const flagged =
      (await safety(templateText(premise.a))).flagged ||
      (await safety(templateText(premise.b))).flagged;
    if (flagged) return 'rejected';

    await db.insert(duetPremises).values({
      slug: `gen-${randomBytes(4).toString('hex')}`,
      content: premise,
      qualityScore: checked.qualityScore,
    });
    return 'ready';
  } catch {
    // The model or moderation unreachable, or output that would not parse:
    // nothing is written, and the next run tries again.
    return 'failed';
  }
}

/**
 * Tops the stock up to `DUET_PREMISE_STOCK`, at most `DUET_PREMISES_PER_RUN`
 * attempts a run. Counts only: a premise is about nobody, but nothing of one
 * is logged either.
 */
export async function fillDuetPremises(
  deps: DuetPremiseDeps = {}
): Promise<Record<string, number>> {
  const result = { stock: 0, written: 0, rejected: 0, failed: 0 };
  let stock = (await premiseSlugs(db)).length;
  for (let attempt = 0; attempt < DUET_PREMISES_PER_RUN && stock < DUET_PREMISE_STOCK; attempt++) {
    const outcome = await writeDuetPremise(deps);
    if (outcome === 'ready') {
      result.written += 1;
      stock += 1;
    } else {
      result[outcome] += 1;
    }
  }
  result.stock = stock;
  return result;
}
