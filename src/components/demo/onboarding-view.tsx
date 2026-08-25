"use client"

import Image from "next/image"

// The launch sequence. Stark white, heavy grotesque type, asymmetric
// composition on a descending diagonal: mark top-left, headline stepping down
// and right, action bottom-right.
//
// Desktop positions are proportional rather than fixed so the composition
// survives a resized window — the diagonal is the design, and it has to hold.
// Below `md` the diagonal has nowhere to go, so the type stacks instead.

const LINE_ONE = "your real life."
const LINE_TWO = "infinitely playable."

export function OnboardingView({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="font-grotesque relative h-full w-full overflow-hidden bg-white text-black">
      <Image
        src="/bramble-logo.png"
        alt="bramble"
        width={144}
        height={144}
        priority
        className="absolute left-[3.2%] top-[4%] w-[14vw] max-w-[92px] md:w-[6.6vw]"
      />

      {/* Mobile: stacked, echoing the landing page. */}
      <div className="flex h-full flex-col justify-center gap-24 px-6 md:hidden">
        <p className="text-left text-3xl font-bold leading-none tracking-tight">{LINE_ONE}</p>
        <p className="text-right text-3xl font-bold leading-none tracking-tight">{LINE_TWO}</p>
      </div>

      {/* Desktop: the diagonal. */}
      <p className="absolute left-[20%] top-[40%] hidden font-bold leading-none tracking-[-0.015em] md:block [font-size:4.2vw]">
        {LINE_ONE}
      </p>
      <p className="absolute left-[51%] top-[53%] hidden font-bold leading-none tracking-[-0.015em] md:block [font-size:4.2vw]">
        {LINE_TWO}
      </p>

      <div className="absolute bottom-[10%] right-[8%] md:bottom-[15.5%] md:right-[11%]">
        <button
          type="button"
          onClick={onFinish}
          autoFocus
          // Sharp corners — no radius anywhere in this design.
          className="cursor-pointer bg-black px-8 py-4 text-base font-bold text-white transition-opacity hover:opacity-85 md:[font-size:1.51vw] md:[padding:1.76vw_3.57vw]"
        >
          Begin
        </button>
      </div>
    </div>
  )
}
