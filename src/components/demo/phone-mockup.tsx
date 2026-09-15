'use client';

import { useSyncExternalStore } from 'react';
import { PortraitCircle } from './portrait-circle';

// A lock screen, drawn rather than dropped in as an image, so the
// notifications are live text that updates as the story advances.
//
// Everything is sized in `cqw` against the phone's own width, which is the
// direct translation of the SwiftUI original's `width * k` metrics.

const SCREEN_COLOR = 'rgb(20, 21, 33)';

const TICK_MS = 15_000;

function subscribeToClock(onChange: () => void) {
  const id = setInterval(onChange, TICK_MS);
  return () => clearInterval(id);
}

/** Bucketed so the snapshot is stable between ticks, which is what
 *  useSyncExternalStore requires. */
function clockSnapshot() {
  return Math.floor(Date.now() / TICK_MS);
}

/**
 * Real current time — a demo clock that matches the room's clock reads as live
 * rather than as a screenshot. The server snapshot is null because it has no
 * idea what time it is where the viewer is; the face fills in on hydration.
 */
function useLockScreenClock() {
  const tick = useSyncExternalStore(subscribeToClock, clockSnapshot, () => null);
  if (tick === null) return { time: '', date: '' };

  const now = new Date(tick * TICK_MS);
  return {
    time: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`,
    date: now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
  };
}

export function PhoneMockup({
  contactName,
  portrait,
  notifications,
  isTyping,
}: {
  contactName: string;
  portrait?: string | null;
  /** Newest last. Only the most recent few are shown, as on a real lock screen. */
  notifications: string[];
  isTyping: boolean;
}) {
  const { time, date } = useLockScreenClock();
  const visible = notifications.slice(-3);

  return (
    <div className="@container relative w-full" style={{ aspectRatio: '1 / 2.35' }}>
      {/* Bezel */}
      <div
        className="h-full w-full"
        style={{
          borderRadius: '13.5cqw',
          padding: '2.8cqw',
          background:
            'linear-gradient(135deg, rgb(71,71,71) 0%, rgb(26,26,26) 50%, rgb(56,56,56) 100%)',
          boxShadow: '0 4cqw 9cqw rgba(0,0,0,0.28)',
        }}
      >
        {/* Screen */}
        <div
          className="relative flex h-full w-full flex-col overflow-hidden"
          style={{ borderRadius: '12.4cqw', backgroundColor: SCREEN_COLOR }}
        >
          <StatusBar />
          <DynamicIsland />

          <div style={{ height: '10cqw' }} />

          <div className="flex flex-col items-center text-white">
            <span
              className="leading-none font-light tabular-nums"
              style={{ fontSize: '23.5cqw', fontFamily: 'ui-rounded, system-ui, sans-serif' }}
            >
              {time || ' '}
            </span>
            <span
              className="font-medium text-white/90"
              style={{ fontSize: '5.2cqw', paddingTop: '0.5cqw' }}
            >
              {date || ' '}
            </span>
          </div>

          <div style={{ height: '10cqw' }} />

          <div
            className="flex flex-col"
            style={{ gap: '2.2cqw', paddingLeft: '4.5cqw', paddingRight: '4.5cqw' }}
          >
            {visible.map((text, index) => (
              <NotificationCard
                key={`${index}-${text}`}
                text={text}
                contactName={contactName}
                portrait={portrait}
                isLatest={index === visible.length - 1}
              />
            ))}
            {isTyping && <TypingCard />}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div
      className="flex items-center justify-end text-white"
      style={{ gap: '1.8cqw', paddingLeft: '7.5cqw', paddingRight: '7.5cqw', paddingTop: '4.5cqw' }}
    >
      <CellularBars />
      <Wifi />
      <Battery />
    </div>
  );
}

function CellularBars() {
  return (
    <svg viewBox="0 0 16 11" style={{ width: '5cqw' }} fill="currentColor" aria-hidden>
      <rect x="0" y="7.5" width="2.6" height="3.5" rx="0.7" />
      <rect x="4.4" y="5.5" width="2.6" height="5.5" rx="0.7" />
      <rect x="8.8" y="3" width="2.6" height="8" rx="0.7" />
      <rect x="13.2" y="0" width="2.6" height="11" rx="0.7" opacity="0.4" />
    </svg>
  );
}

function Wifi() {
  return (
    <svg
      viewBox="0 0 16 12"
      style={{ width: '5cqw' }}
      fill="none"
      stroke="currentColor"
      aria-hidden
    >
      <path d="M1 3.6a10.5 10.5 0 0 1 14 0" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M3.6 6.6a6.6 6.6 0 0 1 8.8 0" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.2 9.5a2.8 2.8 0 0 1 3.6 0" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Battery() {
  return (
    <svg viewBox="0 0 26 12" style={{ width: '7.5cqw' }} aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="22"
        height="11"
        rx="3.2"
        fill="none"
        stroke="currentColor"
        opacity="0.5"
      />
      <rect x="2" y="2" width="15" height="8" rx="2" fill="currentColor" />
      <path d="M24 4.2v3.6a2 2 0 0 0 0-3.6Z" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function DynamicIsland() {
  return (
    <div
      className="mx-auto rounded-full bg-black"
      style={{ width: '30cqw', height: '8.5cqw', marginTop: '-5.5cqw' }}
    />
  );
}

function NotificationCard({
  text,
  contactName,
  portrait,
  isLatest,
}: {
  text: string;
  contactName: string;
  portrait?: string | null;
  isLatest: boolean;
}) {
  return (
    <div
      className="flex [animation:bramble-rise_300ms_ease-out] items-start"
      style={{
        gap: '3cqw',
        padding: '3.5cqw',
        borderRadius: '6.2cqw',
        backgroundColor: `rgba(255,255,255,${isLatest ? 0.16 : 0.09})`,
        opacity: isLatest ? 1 : 0.72,
      }}
    >
      <PortraitCircle
        src={portrait}
        fallback={contactName}
        sizes="60px"
        className="shrink-0"
        style={{ width: '8.8cqw' }}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '0.8cqw' }}>
        <div className="flex items-baseline justify-between" style={{ gap: '2cqw' }}>
          <span className="font-semibold text-white uppercase" style={{ fontSize: '4.3cqw' }}>
            {contactName}
          </span>
          <span className="shrink-0 text-white/45" style={{ fontSize: '3.6cqw' }}>
            {isLatest ? 'now' : 'earlier'}
          </span>
        </div>
        <p className="text-white/90" style={{ fontSize: '4.4cqw', lineHeight: 1.3 }}>
          {text}
        </p>
      </div>
    </div>
  );
}

/** Covers the pause between beats with something in-world rather than a spinner. */
function TypingCard() {
  return (
    <div
      className="flex w-fit items-center rounded-full"
      style={{
        gap: '1.8cqw',
        padding: '3.5cqw 5.5cqw',
        marginLeft: '2cqw',
        backgroundColor: 'rgba(255,255,255,0.12)',
      }}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="rounded-full bg-white/65"
          style={{
            width: '2.2cqw',
            height: '2.2cqw',
            animation: `bramble-typing 550ms ease-in-out ${index * 180}ms infinite`,
          }}
        />
      ))}
    </div>
  );
}
