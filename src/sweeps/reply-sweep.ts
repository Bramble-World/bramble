import { sweepReplies } from '@/lib/services/generation/reply.sweep';
import { runSweep } from './run';

/**
 * Writes the replies that have come due in stories that paused for one, and
 * sends a notification for each (the story texts you). Every five minutes.
 */
void runSweep('reply-sweep', () => sweepReplies());
