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
 *
 * `/open/story#…` is the link ChatGPT writes to make a story: the situation is
 * in the fragment, which never reaches this server, and only the app can send
 * it. Without the app, this page says where to open it.
 */
export default async function OpenApp({ params }: { params: Promise<{ path?: string[] }> }) {
  const [first] = (await params).path ?? [];
  const makesStory = first === 'story';
  const iPhone = await iPhoneBeta();

  return (
    <main className="flex min-h-svh w-full flex-col items-center justify-center gap-10 bg-[#FFFFFB] px-6 py-8">
      <Image src="/bramble-logo.png" alt="bramble" width={72} height={72} priority />
      <p className="max-w-sm text-center text-2xl leading-tight font-bold text-black">
        {makesStory
          ? 'open this link on your iphone, with bramble installed, to make your story.'
          : 'your story is waiting in bramble on your iphone.'}
      </p>
      {iPhone ? (
        <IPhoneBetaButton url={iPhone} />
      ) : (
        <p className="text-center text-base text-black/70">
          {makesStory
            ? 'get bramble, then tap the link again.'
            : 'open the bramble app to play it.'}
        </p>
      )}
      <LegalLinks />
    </main>
  );
}
