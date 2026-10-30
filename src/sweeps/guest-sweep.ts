import { sweepExpiredGuests } from '@/lib/services/guests/guests.service';
import { runSweep } from './run';

/**
 * Deletes guests whose seven days are up. Hourly.
 *
 * The privacy policy promises a guest's story is deleted when it expires, and
 * this is the only thing that keeps the promise: an expired guest can no longer
 * play (every request re-checks `guestExpiresAt`), but their rows would
 * otherwise stay. Hourly is well inside "deleted when it expires" for a promise
 * measured in days, and a pass over nothing is one indexed query.
 */
void runSweep('guest-sweep', sweepExpiredGuests);
