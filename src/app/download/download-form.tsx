'use client';

import { useActionState } from 'react';
import { requestDownload, type DownloadState } from './actions';

const EMPTY: DownloadState = {};

export function DownloadForm() {
  const [state, submit, pending] = useActionState(requestDownload, EMPTY);

  // Once the code is accepted the form is replaced by the link rather than
  // sitting beneath it — there is nothing left to type, and leaving the field
  // there invites someone to wonder whether it worked.
  if (state.url) {
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <a
          href={state.url}
          className="rounded-full bg-black px-8 py-4 text-center text-xl font-bold text-[#FFFFFB] sm:text-2xl"
        >
          download for macOS
        </a>
        {state.label ? <p className="text-sm text-black/60">{state.label}</p> : null}
        <p className="max-w-md text-center text-sm text-black/60">
          macOS 14 or later. If the download does not start, your browser may have blocked it.
        </p>
      </div>
    );
  }

  return (
    <form action={submit} className="flex w-full max-w-md flex-col items-center gap-4">
      <label htmlFor="code" className="sr-only">
        Beta access code
      </label>
      <input
        id="code"
        name="code"
        type="text"
        required
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="your access code"
        aria-describedby={state.error ? 'code-error' : undefined}
        aria-invalid={state.error ? true : undefined}
        className="w-full rounded-full border border-black/15 bg-white px-6 py-4 text-center text-lg text-black placeholder:text-black/35 focus:border-black focus:outline-none"
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-black px-8 py-4 text-xl font-bold text-[#FFFFFB] disabled:opacity-50"
      >
        {pending ? 'checking…' : 'get the app'}
      </button>

      {/* Polite rather than assertive: it follows the reader's own action, so it
          does not need to interrupt whatever they are doing. */}
      {state.error ? (
        <p id="code-error" role="status" className="text-center text-sm text-black/70">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
