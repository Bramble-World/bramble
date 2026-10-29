import { energyView, type EnergyView } from '@/lib/api/views';
import { energyFor } from '@/lib/services/sessions/energy.service';
import { PublicUser } from '@/lib/services/users/users.types';

/**
 * The `energy` key every play response carries, for whoever is asking.
 *
 * Null for a guest, who has no energy: they play a fixed three beats and are
 * then asked to sign up, never told they have run out. A real balance would be
 * a number the app has no screen for, and a misleading one — it would count
 * down from twenty when three is the actual limit. Once they sign up, the turns
 * they played count toward their account's energy like any others.
 */
export async function readerEnergy(user: PublicUser): Promise<EnergyView | null> {
  if (user.isGuest) return null;
  return energyView(await energyFor(user.id));
}
