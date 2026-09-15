import Image from 'next/image';

export default function Home() {
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

      <a
        href="https://discord.gg/xVapjPubw"
        className="mb-8 self-center rounded-full px-6 py-3 text-center text-xl font-bold text-black sm:text-2xl md:text-3xl"
      >
        click here to join the discord and beta test Bramble
      </a>
    </main>
  );
}
