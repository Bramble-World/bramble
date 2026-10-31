import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  DownloadButton,
  IPhoneBetaButton,
  iPhoneBeta,
  macBuild,
} from '@/components/download/download-button';
import { LegalLinks } from '@/components/legal/legal-page';
import { DISCORD_INVITE_URL } from '@/lib/links';

/**
 * Where a beta tester gets the app: the iPhone beta on TestFlight, and the
 * macOS app while it is still offered.
 *
 * The home page carries the same link; this URL exists because it is the one
 * already shared with testers, and because the requirements and the build
 * number belong somewhere a reader can be sent to.
 */
export const metadata: Metadata = {
  title: 'Download Bramble',
  description: 'Bramble for iPhone and Mac, for beta testers.',
};

export default async function Download() {
  const [iPhone, build] = await Promise.all([iPhoneBeta(), macBuild()]);

  return (
    <main className="relative flex min-h-svh w-full flex-col overflow-hidden bg-[#FFFFFB] px-6 py-8">
      <header>
        <Link href="/">
          <Image
            src="/bramble-logo.png"
            alt="bramble"
            width={72}
            height={72}
            priority
            className="h-14 w-14 md:h-16 md:w-16"
          />
        </Link>
      </header>

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-10">
        <div className="flex flex-col items-center gap-3">
          <h1 className="text-center text-2xl leading-none font-bold text-black sm:text-3xl md:text-4xl">
            {iPhone ? 'get bramble' : 'bramble for mac'}
          </h1>
          <p className="max-w-md text-center text-base text-black/60">
            {iPhone || build
              ? 'The beta is open. Install it and sign in to start.'
              : 'There is no build to download yet. Join the Discord and we will say when there is.'}
          </p>
        </div>

        {iPhone ? <IPhoneBetaButton url={iPhone} /> : null}
        {build ? <DownloadButton build={build} /> : null}
      </div>

      <a
        href={DISCORD_INVITE_URL}
        className="mb-8 self-center text-center text-base font-bold text-black/70 sm:text-lg"
      >
        join the discord
      </a>

      <LegalLinks />
    </main>
  );
}
