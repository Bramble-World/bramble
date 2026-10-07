import { sweepIdleSessions } from '@/lib/services/generation/arc.service';
import { runSweep } from './run';

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
 * Recomputes arc summaries for storylines nobody is playing. Hourly.
 *
 * `arcSummary` is fed back into the turn prompt as "So far", so it is how the
 * model knows what the story has become. Hourly rather than continuously,
 * because the work is only worth doing once a session has gone quiet, and
 * `summarizeArc` skips any storyline whose summary is already newer than its
 * newest beat — so a pass over nothing costs one query per storyline and no
 * model calls at all.
 */
void runSweep('arc-sweep', () => sweepIdleSessions(IDLE_FOR));
