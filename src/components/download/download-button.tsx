import { connection } from 'next/server';
import { env } from '@/env';
import { TrackedLink } from './tracked-link';

/**
 * The iPhone beta's TestFlight link, or `null` until there is one.
 *
 * **Read at request time, not build time.** `connection()` opts the calling route
 * out of being prerendered, which is the whole point: one image is promoted
 * through every environment, and the link should change by setting a variable
 * rather than by rebuilding. Statically prerendered, this would bake in whatever
 * `IOS_TESTFLIGHT_URL` was — usually nothing, since the image is built without
 * secrets — and never look again. See
 * `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`.
 *
 * Returning `null` rather than throwing lets a deployment with no link configured
 * render an honest page instead of a 500 or a dead button.
 */
export async function iPhoneBeta(): Promise<string | null> {
  await connection();

  return env.IOS_TESTFLIGHT_URL ?? null;
}

/**
 * The iPhone beta: one link to its TestFlight page, which installs TestFlight
 * first if needed and then Bramble.
 */
export function IPhoneBetaButton({ url }: { url: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <TrackedLink
        cta="iphone_beta"
        href={url}
        className="rounded-full bg-black px-8 py-4 text-center text-xl font-bold text-[#FFFFFB] sm:text-2xl"
      >
        get the iPhone beta
      </TrackedLink>
      <p className="text-center text-sm text-black/60">on TestFlight · iOS 18 or later</p>
    </div>
  );
}
