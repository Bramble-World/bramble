'use client';

import posthog from 'posthog-js';

/**
 * A link that tells PostHog it was pressed, because pressing it is the thing the
 * landing page exists for. Autocapture is off (see `instrumentation-client.ts`),
 * so this is the only click the website reports.
 *
 * Sent by beacon because the press navigates away: a queued event would be lost
 * with the page. Does nothing when PostHog was never started.
 */
export function TrackedLink({
  cta,
  ...link
}: React.ComponentProps<'a'> & { cta: 'iphone_beta' | 'discord' }) {
  return (
    <a
      {...link}
      onClick={() => {
        if (!posthog.__loaded) return;
        posthog.capture(
          'landing_cta_clicked',
          { cta },
          { send_instantly: true, transport: 'sendBeacon' }
        );
      }}
    />
  );
}
