import { sweepPush } from '@/lib/services/push/push.sweep';
import { runSweep } from './run';

/**
 * Sends the notifications that are due. Every ten minutes.
 *
 * Off until `PUSH_ENABLED=true`, which is also the way to stop it quickly.
 */
void runSweep('push-sweep', () => sweepPush());
