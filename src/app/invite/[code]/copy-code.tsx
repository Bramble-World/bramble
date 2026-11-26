'use client';

import { useState } from 'react';

/** The code, and a button that copies it, so it can be pasted into the app. */
export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3">
      <p
        className="font-mono text-5xl font-bold tracking-[0.3em] text-black sm:text-6xl"
        aria-label={`invite code ${code.split('').join(' ')}`}
      >
        {code}
      </p>
      <button
        type="button"
        className="rounded-full border border-black px-6 py-2 text-base font-bold text-black"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'copied' : 'copy code'}
      </button>
    </div>
  );
}
