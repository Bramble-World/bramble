'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils';
import {
  parseCsvTranscript,
  splitIntoThreads,
  type Thread,
} from '@/lib/services/generation/csv-transcript';
import type { ActionResult } from '@/app/lab/actions';

type Props = {
  action: (thread: { handle: string; messages: Thread['messages'] }) => Promise<ActionResult>;
  minMessages: number;
  maxChars: number;
};

type Row = { thread: Thread; state: 'pending' | 'running' | 'done' | 'failed'; note?: string };

/**
 * Imports a message export and turns each real conversation into a storyline.
 *
 * The file is read, parsed and split **in the browser** — the parser is pure and
 * has no server dependency — so the export never leaves this page. Only the
 * thread currently being extracted is sent, one at a time.
 *
 * One request per thread, rather than one for the file, because 39 generations
 * at high reasoning effort run to many minutes: too long to hold a request open,
 * with no way to show progress, and nothing kept if it fails half way. Here each
 * thread that succeeds is a storyline that stays, whatever happens after it.
 */
export function ImportExport({ action, minMessages, maxChars }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [running, startRun] = useTransition();

  async function inspect(file: File) {
    setError(null);
    setRows(null);
    setFilename(file.name);
    try {
      const { transcript } = parseCsvTranscript(await file.text());
      const threads = splitIntoThreads(transcript, { minMessages, maxChars });
      if (threads.length === 0) {
        setError(`No conversation in that file reached ${minMessages} messages.`);
        return;
      }
      setRows(threads.map((thread) => ({ thread, state: 'pending' as const })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that file.');
    }
  }

  function extractAll() {
    if (!rows) return;
    startRun(async () => {
      // Sequential on purpose. Next dispatches actions one at a time per client
      // anyway, and each is a paid model call worth seeing the result of before
      // the next begins.
      for (let i = 0; i < rows.length; i += 1) {
        setRows((current) =>
          current!.map((row, index) => (index === i ? { ...row, state: 'running' } : row))
        );
        const result = await action({
          handle: rows[i].thread.handle,
          messages: rows[i].thread.messages,
        });
        setRows((current) =>
          current!.map((row, index) =>
            index === i
              ? { ...row, state: result.ok ? 'done' : 'failed', note: result.message }
              : row
          )
        );
      }
    });
  }

  const done = rows?.filter((r) => r.state === 'done').length ?? 0;
  const failed = rows?.filter((r) => r.state === 'failed').length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={cn(
            'border-border hover:bg-muted cursor-pointer rounded-md border px-3 py-1.5 text-sm',
            running && 'pointer-events-none opacity-50'
          )}
        >
          Choose an export…
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={running}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void inspect(file);
            }}
          />
        </label>

        {rows && (
          <button
            type="button"
            onClick={extractAll}
            disabled={running}
            className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50"
          >
            {running
              ? `Extracting ${done + failed + 1} of ${rows.length}…`
              : `Extract ${rows.length} conversations`}
          </button>
        )}

        {filename && <span className="text-muted-foreground text-xs">{filename}</span>}
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      {rows && (
        <>
          <p className="text-muted-foreground text-xs">
            {rows.length} conversations of at least {minMessages} messages.{' '}
            {rows.filter((r) => r.thread.truncated).length > 0 &&
              `${rows.filter((r) => r.thread.truncated).length} trimmed to their most recent messages. `}
            Each is one model call.
          </p>

          <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto text-xs">
            {rows.map((row, index) => (
              <li key={index} className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'w-14 shrink-0',
                    row.state === 'done' && 'text-muted-foreground',
                    row.state === 'failed' && 'text-destructive',
                    row.state === 'running' && 'font-medium'
                  )}
                >
                  {row.state === 'pending' && '·'}
                  {row.state === 'running' && '…'}
                  {row.state === 'done' && 'done'}
                  {row.state === 'failed' && 'failed'}
                </span>
                <span className="truncate">{row.thread.handle}</span>
                <span className="text-muted-foreground shrink-0">
                  {row.thread.messages.length} msgs
                  {row.thread.truncated && ' · trimmed'}
                </span>
                {row.note && (
                  <span
                    className={cn(
                      'truncate',
                      row.state === 'failed' ? 'text-destructive' : 'text-muted-foreground/70'
                    )}
                  >
                    {row.note}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}

      <p className="text-muted-foreground/70 text-xs">
        The export is parsed in this page and never uploaded. Each conversation reaches the model as
        it is extracted; only the retelling is stored.
      </p>
    </div>
  );
}
