import { sweepEndings } from '@/lib/services/endings/ending.sweep';
import { runSweep } from './run';

/**
 * Writes the ending pages nothing else got to. Every five minutes.
 *
 * The backstop for an ending whose write was cut short (a deploy, a restart)
 * or failed, for a reader who isn't there to read the session again. Bounded
 * per run, and each session to `ENDING_MAX_ATTEMPTS` in all.
 */
void runSweep('ending-sweep', () => sweepEndings());
