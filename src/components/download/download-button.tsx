import { connection } from 'next/server';
import { env } from '@/env';

export type MacBuild = { url: string; label: string | null };

/**
 * The macOS build on offer, or `null` when there is nothing to download yet.
 *
 * **Read at request time, not build time.** `connection()` opts the calling route
 * out of being prerendered, which is the whole point: one image is promoted
 * through every environment, and cutting a release should change the link by
 * setting a variable rather than by rebuilding. Statically prerendered, this
 * would bake in whatever `MACOS_DOWNLOAD_URL` was — usually nothing, since the
 * image is built without secrets — and never look again. See
 * `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`.
 *
 * Returning `null` rather than throwing lets a deployment with no build
 * configured render an honest page instead of a 500 or a dead button.
 */
export async function macBuild(): Promise<MacBuild | null> {
  await connection();

  if (!env.MACOS_DOWNLOAD_URL) return null;
  return { url: env.MACOS_DOWNLOAD_URL, label: env.MACOS_BUILD_LABEL ?? null };
}

/**
 * The download itself: one link straight to the build, and what you need to run
 * it. No interstitial and no form — the link is public, so anything in front of
 * it would only be in the reader's way.
 */
export function DownloadButton({ build }: { build: MacBuild }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <a
        href={build.url}
        className="rounded-full bg-black px-8 py-4 text-center text-xl font-bold text-[#FFFFFB] sm:text-2xl"
      >
        download for macOS
      </a>
      <p className="text-center text-sm text-black/60">
        {build.label ? `${build.label} · ` : ''}macOS 14 or later
      </p>
    </div>
  );
}
