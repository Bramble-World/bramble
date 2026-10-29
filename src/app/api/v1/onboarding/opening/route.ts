import { withGuest } from '@/lib/api/with-user';
import { json } from '@/lib/api/respond';
import { chooseOpening } from '@/lib/onboarding/openings';
import { track } from '@/lib/analytics/analytics';

/**
 * Which opening the first screen shows.
 *
 * Asked rather than built into the app, so openings can be tested against each
 * other without a release. Deterministic per guest: asking again returns the
 * same one, which is the one `POST /api/v1/onboarding/story` must then be given.
 *
 * Only the phone the first screen shows — no headline, no choices, nothing about
 * who is texting. The reader names that person next, and beat 1 is written with
 * the name when they do.
 */
export const GET = withGuest(async (user) => {
  const opening = chooseOpening(user.id);

  // The top of the onboarding funnel, so it is counted where it is served. The
  // id, never the text.
  await track(user.id, { name: 'onboarding_opened', properties: { opening_id: opening.id } });

  return json({
    opening: {
      id: opening.id,
      clockTime: opening.phone.clockTime,
      dateLabel: opening.phone.dateLabel,
      text: opening.phone.text,
      timeLabel: opening.phone.timeLabel,
    },
  });
});
