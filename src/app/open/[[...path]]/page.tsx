import type { Metadata } from 'next';
import Image from 'next/image';
import { IPhoneBetaButton, iPhoneBeta } from '@/components/download/download-button';
import { LegalLinks } from '@/components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Open Bramble',
  robots: { index: false },
};

/**
 * Where a "open bramble" link lands when the app isn't installed: with the app,
 * iOS opens it instead and this page is never seen (universal links,
 * `/.well-known/apple-app-site-association`).
 */
export default async function OpenApp() {
  const iPhone = await iPhoneBeta();

  return (
    <main className="flex min-h-svh w-full flex-col items-center justify-center gap-10 bg-[#FFFFFB] px-6 py-8">
      <Image src="/bramble-logo.png" alt="bramble" width={72} height={72} priority />
      <p className="max-w-sm text-center text-2xl leading-tight font-bold text-black">
        your story is waiting in bramble on your iphone.
      </p>
      {iPhone ? (
        <IPhoneBetaButton url={iPhone} />
      ) : (
        <p className="text-center text-base text-black/70">open the bramble app to play it.</p>
      )}
      <LegalLinks />
    </main>
  );
}
