import { NotFoundError } from '@/lib/utils/errors';
import { getGenerator } from '@/lib/ai';
import { arcPrompt } from '@/lib/ai/prompts/arc.prompt';
import * as storylineReader from '../storylines/storylines.reader';
import * as storylineWriter from '../storylines/storylines.writer';
import * as sessionReader from '../sessions/sessions.reader';
import { assembleStorylineContext } from './context.reader';
import { GenerationDeps } from './turns.service';

export type ArcOutcome = 'written' | 'already-current' | 'nothing-to-summarise' | 'superseded';

/**
 * Recomputes a storyline's arc summary, if it needs one.
 *
 * Four phases, and the ordering of the first is the whole correctness argument:
 * the watermark is read **before** the model call and written afterwards
 * unchanged. Stamping the row with `now()` instead would swallow any event
 * written while the model was thinking — that event's `createdAt` would land
 * before the recorded timestamp, so the staleness check would conclude there was
 * nothing to recompute and keep concluding it. The summary would be permanently
 * wrong with nothing reporting a problem.
 *
 * The write is conditional on nobody else having summarised in the meantime.
 * Recomputation is triggered by idleness rather than held under a lock, so two
 * sweeps overlapping is ordinary; losing that race means the other summary is
 * newer and this one should be discarded.
 */
export async function summarizeArc(
  userId: string,
  storylineId: string,
  deps: GenerationDeps = {}
): Promise<ArcOutcome> {
  const storyline = await storylineReader.getStoryline(userId, storylineId);
  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  const watermark = await storylineReader.newestEventCreatedAt(storylineId);
  if (!watermark) return 'nothing-to-summarise';

  const observed = storyline.arcSummaryGeneratedAt;
  // Strictly newer: an event created in the same instant as the last summary was
  // already accounted for.
  if (observed && observed >= watermark) return 'already-current';

  const context = await assembleStorylineContext(userId, storylineId);

  const generator = deps.generator ?? getGenerator();
  const { value } = await generator.run(arcPrompt, { storyline: context });

  const won = await storylineWriter.setArcSummaryIfUnchanged({
    storylineId,
    summary: value.arcSummary,
    watermark,
    expected: observed,
  });

  return won ? 'written' : 'superseded';
}

export type SweepResult = {
  considered: number;
  written: number;
  skipped: number;
};

/**
 * Recomputes summaries for storylines nobody is currently playing.
 *
 * Nothing marks a session as finished — people just stop — so idleness is
 * inferred from `lastActiveAt`, which is why that column is denormalised and
 * indexed. One session per storyline is enough to make the storyline a
 * candidate, hence the de-duplication.
 *
 * Failures are counted, not thrown. A sweep is a background pass over unrelated
 * storylines, and one model failure should not stop the rest.
 */
export async function sweepIdleSessions(
  idleFor: number,
  deps: GenerationDeps = {}
): Promise<SweepResult> {
  const idleSince = new Date(Date.now() - idleFor);
  const owners = await sessionReader.findIdleSessionOwners(idleSince);

  // One session is enough to make its storyline a candidate; several sessions on
  // one storyline should not summarise it several times.
  const byStoryline = new Map<string, string>();
  for (const { storylineId, userId } of owners) {
    if (!byStoryline.has(storylineId)) byStoryline.set(storylineId, userId);
  }

  let written = 0;
  let skipped = 0;

  for (const [storylineId, userId] of byStoryline) {
    try {
      const outcome = await summarizeArc(userId, storylineId, deps);
      if (outcome === 'written') written += 1;
      else skipped += 1;
    } catch {
      // Counted as skipped rather than rethrown: the next storyline is unrelated
      // and should still get its turn.
      skipped += 1;
    }
  }

  return { considered: byStoryline.size, written, skipped };
}
