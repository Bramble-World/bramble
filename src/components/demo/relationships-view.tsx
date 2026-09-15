'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { PortraitCircle } from './portrait-circle';

// Onboarding II — "import" the player's relationships.
//
// Deliberately no contacts API here. The real app reads the address book; the
// demo only needs to *look* like it does, and a live permission prompt in a
// pitch is pure downside — it can be declined, and a denial state is a dead end
// on stage. The circles from the mockup drift, the cast fades onto them, and
// nothing leaves the browser.

type Phase = 'idle' | 'scanning' | 'picking';

type Spot = { x: number; y: number; radius: number; visible: boolean };

type MockContact = {
  id: string;
  name: string;
  portrait: string;
  /** Null means this one hasn't been "found" yet. */
  idle: Spot | null;
  scanning: { x: number; y: number };
  settled: { x: number; y: number };
};

/** The cast the graph and stories use — picking Maya here and meeting her
 *  again two screens later is the whole point. */
const ROSTER: MockContact[] = [
  {
    id: 'maya',
    name: 'Maya',
    portrait: '/portraits/maya.png',
    idle: { x: 0.174, y: 0.498, radius: 0.075, visible: true },
    scanning: { x: 0.3, y: 0.415 },
    settled: { x: 0.16, y: 0.56 },
  },
  {
    id: 'jordan',
    name: 'Jordan',
    portrait: '/portraits/talia.png',
    idle: { x: 0.384, y: 0.633, radius: 0.086, visible: true },
    scanning: { x: 0.52, y: 0.665 },
    settled: { x: 0.335, y: 0.62 },
  },
  {
    id: 'dani',
    name: 'Dani',
    portrait: '/portraits/naomi.png',
    idle: { x: 0.603, y: 0.472, radius: 0.08, visible: true },
    scanning: { x: 0.435, y: 0.4 },
    settled: { x: 0.5, y: 0.54 },
  },
  {
    id: 'theo',
    name: 'Theo',
    portrait: '/portraits/maxim.png',
    idle: { x: 0.829, y: 0.577, radius: 0.081, visible: true },
    scanning: { x: 0.68, y: 0.585 },
    settled: { x: 0.665, y: 0.62 },
  },
  {
    id: 'marcus',
    name: 'Marcus',
    portrait: '/portraits/marcus.png',
    idle: null,
    scanning: { x: 0.58, y: 0.48 },
    settled: { x: 0.84, y: 0.56 },
  },
];

export const CAST_NAMES = ROSTER.map((person) => person.name);

function spotFor(person: MockContact, phase: Phase): Spot {
  switch (phase) {
    case 'idle':
      return person.idle ?? { ...person.scanning, radius: 0.055, visible: false };
    case 'scanning':
      return { ...person.scanning, radius: 0.066, visible: true };
    case 'picking':
      return { ...person.settled, radius: 0.058, visible: true };
  }
}

const SUBTITLE: Record<Phase, string> = {
  idle: "we'll use your relationships to shape your story.",
  scanning: 'finding the people who matter…',
  picking: 'these are the people your stories revolve around.',
};

export function RelationshipsView({ onContinue }: { onContinue: (names: string[]) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  /** Two stages on purpose: the circles drift somewhere new first, *then*
   *  settle into a row as the faces resolve. One straight move to the final
   *  layout reads as a jump cut. */
  function runScan() {
    setPhase('scanning');
    timer.current = setTimeout(() => setPhase('picking'), 950);
  }

  return (
    <div className="font-grotesque relative h-full w-full overflow-hidden bg-white text-black">
      <Image
        src="/bramble-logo.png"
        alt="bramble"
        width={144}
        height={144}
        className="absolute top-[4%] left-[3.2%] w-[14vw] max-w-[92px] md:w-[6.6vw]"
      />

      <div className="absolute top-[18%] left-[8.6%] md:top-[23.5%]">
        <h1 className="text-2xl leading-tight font-bold tracking-[-0.015em] md:[font-size:3.3vw]">
          let&apos;s get to know you.
        </h1>
        <p
          key={phase}
          className="mt-2 [animation:bramble-fade_400ms_ease-out] text-sm text-black/75 md:[font-size:1.06vw]"
        >
          {SUBTITLE[phase]}
        </p>
      </div>

      {/* Stage */}
      <div className="absolute inset-0">
        {ROSTER.map((person, index) => {
          const spot = spotFor(person, phase);
          const settled = phase === 'picking';
          return (
            <div
              key={person.id}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-all duration-[850ms] [transition-timing-function:cubic-bezier(0.22,1.2,0.36,1)]"
              style={{
                left: `${spot.x * 100}%`,
                top: `${spot.y * 100}%`,
                width: `${spot.radius * 200}%`,
                opacity: spot.visible ? 1 : 0,
                scale: spot.visible ? '1' : '0.4',
                transitionDelay: `${index * 50}ms`,
              }}
            >
              <div className="relative w-full">
                <div className="aspect-square w-full rounded-full bg-[#dadada]" />
                {/* Fades on only once the circles have settled — the photos are
                    the payoff of the animation, not its start. */}
                <PortraitCircle
                  src={person.portrait}
                  fallback={person.name}
                  grayscale
                  sizes="(max-width: 768px) 30vw, 15vw"
                  className="absolute inset-0 w-full transition-opacity duration-500"
                  style={{ opacity: settled ? 1 : 0 }}
                />
              </div>
              <span
                className="mt-[8%] text-[10px] whitespace-nowrap transition-opacity duration-500 md:[font-size:1.15vw]"
                style={{ opacity: settled ? 1 : 0 }}
              >
                {person.name}
              </span>
            </div>
          );
        })}
      </div>

      <div className="absolute right-[6%] bottom-[10%] md:right-[4.6%] md:bottom-[15.5%]">
        {phase === 'idle' && (
          <BlackButton onClick={runScan}>Import Relationships &amp; History</BlackButton>
        )}
        {phase === 'scanning' && <BlackButton disabled>Reading your relationships…</BlackButton>}
        {phase === 'picking' && (
          <BlackButton onClick={() => onContinue(CAST_NAMES)}>Next</BlackButton>
        )}
      </div>
    </div>
  );
}

function BlackButton({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-5 py-3 text-sm font-bold text-white transition-opacity md:[padding:1.32vw_2.05vw] md:[font-size:1.52vw] ${
        disabled ? 'cursor-default bg-[#9e9e9e]' : 'cursor-pointer bg-black hover:opacity-85'
      }`}
    >
      {children}
    </button>
  );
}
