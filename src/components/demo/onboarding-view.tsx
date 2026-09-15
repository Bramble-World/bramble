'use client';

import Image from 'next/image';

// The launch sequence. Stark white, heavy grotesque type, asymmetric
// composition on a descending diagonal: mark top-left, headline stepping down
// and right, action bottom-right.
//
// Desktop positions are proportional rather than fixed so the composition
// survives a resized window — the diagonal is the design, and it has to hold.
// Below `md` the diagonal has nowhere to go, so the type stacks instead.

const LINE_ONE = 'your real life.';
const LINE_TWO = 'infinitely playable.';

export function OnboardingView({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="font-grotesque relative h-full w-full overflow-hidden bg-white text-black">
      <Image
        src="/bramble-logo.png"
        alt="bramble"
        width={144}
        height={144}
        priority
        className="absolute top-[4%] left-[3.2%] w-[14vw] max-w-[92px] md:w-[6.6vw]"
      />

      {/* Mobile: stacked, echoing the landing page. */}
      <div className="flex h-full flex-col justify-center gap-24 px-6 md:hidden">
        <p className="text-left text-3xl leading-none font-bold tracking-tight">{LINE_ONE}</p>
        <p className="text-right text-3xl leading-none font-bold tracking-tight">{LINE_TWO}</p>
      </div>

      {/* Desktop: the diagonal. */}
      <p className="absolute top-[40%] left-[20%] hidden [font-size:4.2vw] leading-none font-bold tracking-[-0.015em] md:block">
        {LINE_ONE}
      </p>
      <p className="absolute top-[53%] left-[51%] hidden [font-size:4.2vw] leading-none font-bold tracking-[-0.015em] md:block">
        {LINE_TWO}
      </p>

      <div className="absolute right-[8%] bottom-[10%] md:right-[11%] md:bottom-[15.5%]">
        <button
          type="button"
          onClick={onFinish}
          autoFocus
          // Sharp corners — no radius anywhere in this design.
          className="cursor-pointer bg-black px-8 py-4 text-base font-bold text-white transition-opacity hover:opacity-85 md:[padding:1.76vw_3.57vw] md:[font-size:1.51vw]"
        >
          Begin
        </button>
      </div>
    </div>
  );
}
