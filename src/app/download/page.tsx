import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { DownloadForm } from './download-form';

/**
 * Where a beta tester gets the macOS app.
 *
 * Unlisted rather than secret: the code is what gates the build, but there is no
 * reason for this page to be in an index while the beta is closed.
 */
export const metadata: Metadata = {
  title: 'Download Bramble',
  description: 'Bramble for macOS, for beta testers.',
  robots: { index: false, follow: false },
};

export default function Download() {
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
            bramble for mac
          </h1>
          <p className="max-w-md text-center text-base text-black/60">
            The beta is invite-only. Enter the code we sent you.
          </p>
        </div>

        <DownloadForm />
      </div>

      <a
        href="https://discord.gg/xVapjPubw"
        className="mb-8 self-center text-center text-base font-bold text-black/70 sm:text-lg"
      >
        no code yet? join the discord
      </a>
    </main>
  );
}
