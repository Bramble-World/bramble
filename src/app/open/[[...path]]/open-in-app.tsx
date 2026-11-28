'use client';

import { useSyncExternalStore } from 'react';

/**
 * "open in bramble", for a player who has the app but landed here anyway: a
 * link opened inside another app's browser (ChatGPT's, say) doesn't open the
 * app the way a universal link tapped in Safari or Messages does. The app's
 * own scheme does, so the button hands over the same path and fragment:
 * `bramble://open/story#<the note>`.
 *
 * The fragment is read here in the browser and never reaches the server: on
 * the server the button has no fragment, and it gains `location.hash` once the
 * page is in the browser.
 */
export function OpenInApp({ path }: { path: string }) {
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => '');
  const href = `bramble://${path}${hash}`;

  return (
    <a
      href={href}
      className="rounded-full bg-black px-8 py-4 text-center text-xl font-bold text-[#FFFFFB] sm:text-2xl"
    >
      open in bramble
    </a>
  );
}

function subscribeToHash(changed: () => void) {
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
}

function readHash() {
  return window.location.hash;
}
