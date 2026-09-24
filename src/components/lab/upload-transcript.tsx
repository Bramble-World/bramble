'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/app/lab/actions';

type Props = {
  /** Server action, passed as a reference from the server component. */
  action: (formData: FormData) => Promise<ActionResult>;
};

/**
 * Picks a message export from Finder and extracts a storyline from it.
 *
 * A real `<form action={…}>` rather than a click handler, so the file is posted
 * as multipart FormData — which is the only way a file reaches a Server Action.
 * `useActionState` gives the pending flag and keeps the result across the
 * re-render that follows, which a locally-held state would lose.
 *
 * Extraction on a real history takes a while, so the pending state matters more
 * here than anywhere else in the harness.
 */
export function UploadTranscript({ action }: Props) {
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    null
  );
  const [filename, setFilename] = useState<string | null>(null);

  return (
    <form action={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={cn(
            'border-border hover:bg-muted cursor-pointer rounded-md border px-3 py-1.5 text-sm',
            pending && 'pointer-events-none opacity-50'
          )}
        >
          Choose a CSV…
          <input
            type="file"
            name="csv"
            accept=".csv,text/csv"
            required
            disabled={pending}
            className="sr-only"
            onChange={(event) => setFilename(event.target.files?.[0]?.name ?? null)}
          />
        </label>

        <button
          type="submit"
          disabled={pending || !filename}
          className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Extracting…' : 'Extract from this file'}
        </button>

        {filename && <span className="text-muted-foreground text-xs">{filename}</span>}
      </div>

      {result && (
        <p className={cn('text-xs', result.ok ? 'text-muted-foreground' : 'text-destructive')}>
          {result.message}
        </p>
      )}

      <p className="text-muted-foreground/70 text-xs">
        The file is parsed in memory and never written to disk. With a key configured its text
        reaches the model; only the retelling is stored.
      </p>
    </form>
  );
}
