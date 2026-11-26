import { fillDuetPremises } from '@/lib/services/duets/duet-premise.job';
import { runSweep } from './run';

/**
 * Keeps enough duet premises ready for stories for two. Hourly, at most three
 * written a run, and none once the stock is full.
 */
void runSweep('duet-premise-sweep', () => fillDuetPremises());
