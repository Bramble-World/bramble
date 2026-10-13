import Image from 'next/image';
import { DownloadButton, macBuild } from '@/components/download/download-button';
import { LegalLinks } from '@/components/legal/legal-page';
import { DISCORD_INVITE_URL } from '@/lib/links';

export default async function Home() {
  const build = await macBuild();

  return (
    <main className="relative flex min-h-svh w-full flex-col overflow-hidden bg-[#FFFFFB] px-6 py-8">
      <header>
        <Image
          src="/bramble-logo.png"
          alt="bramble"
          width={72}
          height={72}
          priority
          className="h-14 w-14 md:h-16 md:w-16"
        />
      </header>

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-32 md:gap-68">
        <p className="w-11/12 text-left text-2xl leading-none font-bold text-black sm:text-3xl md:w-3/5 md:text-4xl">
          your real life.
        </p>
        <p className="w-11/12 text-right text-2xl leading-none font-bold text-black sm:text-3xl md:w-3/5 md:text-4xl">
          infinitely playable.
        </p>
      </div>

      {/* The download is the page's one job once there is a build. Until there
          is, the Discord invite is, and it keeps its original wording rather
          than becoming a footnote under a button that is not there. */}
      <div className="mb-8 flex flex-col items-center gap-4 self-center">
        {build ? (
          <>
            <DownloadButton build={build} />
            <a
              href={DISCORD_INVITE_URL}
              className="text-center text-base font-bold text-black/70 sm:text-lg"
            >
              join the discord
            </a>
          </>
        ) : (
          <a
            href={DISCORD_INVITE_URL}
            className="rounded-full px-6 py-3 text-center text-xl font-bold text-black sm:text-2xl md:text-3xl"
          >
            click here to join the discord and beta test Bramble
          </a>
        )}
      </div>

      <LegalLinks />
    </main>
  );
}
