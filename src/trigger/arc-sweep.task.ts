import { schedules } from '@trigger.dev/sdk';
// Relative rather than the `@/` alias: this file is bundled by Trigger.dev
// rather than by Next, and whether that build honours the tsconfig paths is not
// something this repo can verify without a deploy. A relative path works in
// both, and removes a failure mode that would only appear in production.
import { sweepIdleSessions } from '../lib/services/generation/arc.service';

/**
 * How long a session must sit untouched before its storyline is summarised.
 *
 * Nothing marks a session as finished — people just stop — so idleness is
 * inferred from `lastActiveAt`, which is why that column is denormalised and
 * indexed. Thirty minutes is long enough that a pause for coffee does not
 * trigger a recompute underneath someone still playing, and short enough that a
 * summary is current again before they come back.
 */
const IDLE_FOR = 30 * 60 * 1000;

/**
 * Recomputes arc summaries for storylines nobody is playing.
 *
 * This is the piece the loop was missing. `arcSummary` is fed back into the turn
 * prompt as "So far", so it is how the model knows what the story has become —
 * and until now nothing called the sweep except a button in the lab. Both real
 * storylines were stale, one by twenty-four minutes of play, and would have
 * stayed that way: the summary silently described a story that had moved on.
 *
 * Hourly rather than continuously, because the work is only worth doing once a
 * session has gone quiet, and `summarizeArc` skips any storyline whose summary
 * is already newer than its newest beat — so a pass over nothing costs one query
 * per storyline and no model calls at all.
 */
export const arcSweep = schedules.task({
  id: 'arc-sweep',
  cron: '0 * * * *',
  run: async () => {
    const result = await sweepIdleSessions(IDLE_FOR);

    // Returned rather than logged alone, so a run's outcome is visible in the
    // dashboard without reading its logs. `skipped` counts both storylines that
    // were already current and ones whose generation failed — the sweep counts
    // failures rather than throwing, since the next storyline is unrelated.
    return result;
  },
});
