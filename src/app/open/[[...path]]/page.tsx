import type { Metadata } from 'next';
import Image from 'next/image';
import { IPhoneBetaButton, iPhoneBeta } from '@/components/download/download-button';
import { LegalLinks } from '@/components/legal/legal-page';
import { OpenInApp } from './open-in-app';

export const metadata: Metadata = {
  title: 'Open Bramble',
  robots: { index: false },
};

/**
 * Where a "open bramble" link lands when iOS doesn't open the app for it: the
 * app isn't installed, or the link was opened inside another app's browser
 * (ChatGPT's), where universal links don't open apps
 * (`/.well-known/apple-app-site-association`).
 *
 * `/open/story#…` is the link ChatGPT writes to make a story: the situation is
 * in the fragment, which never reaches this server, and only the app can send
 * it. So the page offers both: "open in bramble" (the app's own scheme, with
 * the fragment, `OpenInApp`) for a player who has it, and the app for one who
 * doesn't.
 *
 * Each render logs its kind (`open_page_viewed`), with no path beyond that, no
 * fragment and no address: how often a link lands here instead of the app.
 */
export default async function OpenApp({ params }: { params: Promise<{ path?: string[] }> }) {
  const [first] = (await params).path ?? [];
  const makesStory = first === 'story';
  const iPhone = await iPhoneBeta();
  console.info(JSON.stringify({ event: 'open_page_viewed', kind: makesStory ? 'story' : 'desk' }));

  return (
    <main className="flex min-h-svh w-full flex-col items-center justify-center gap-10 bg-[#FFFFFB] px-6 py-8">
      <Image src="/bramble-logo.png" alt="bramble" width={72} height={72} priority />
      <p className="max-w-sm text-center text-2xl leading-tight font-bold text-black">
        {makesStory
          ? 'tap open in bramble to make your story.'
          : 'your story is waiting in bramble on your iphone.'}
      </p>
      <OpenInApp path={makesStory ? 'open/story' : 'open'} />
      <div className="flex flex-col items-center gap-4">
        <p className="text-center text-base text-black/70">
          {makesStory
            ? "don't have bramble yet? get it, then tap the link in chatgpt again."
            : "don't have bramble yet?"}
        </p>
        {iPhone && <IPhoneBetaButton url={iPhone} />}
      </div>
      <LegalLinks />
    </main>
  );
}
