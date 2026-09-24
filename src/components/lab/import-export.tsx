'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
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
  live: boolean;
};

type State = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
type Row = { thread: Thread; state: State; note?: string };

/**
 * Imports a message export and turns chosen conversations into storylines.
 *
 * The file is read, parsed and split **in the browser** — the parser is pure and
 * has no server dependency — so the export never leaves this page. Only the
 * thread being extracted is sent, one at a time.
 *
 * Nothing is selected to begin with. Every extraction is a paid model call on
 * real messages, so the safe default is that clicking a button starts nothing
 * until something has been picked deliberately. A run over everything is one
 * more click away, and says how many that is.
 *
 * The run is sequential and interruptible. Thirty-nine generations at high
 * reasoning effort take minutes, and discovering that halfway through with no
 * way to stop is worse than slow. Each thread that finished is a storyline that
 * stays.
 */
export function ImportExport({ action, minMessages, maxChars, live }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [running, startRun] = useTransition();
  // A ref, not state: the loop reads it between calls and must see the latest
  // value, which a captured state variable would not give it.
  const stopped = useRef(false);

  const selected = useMemo(() => [...chosen].sort((a, b) => a - b), [chosen]);

  async function inspect(file: File) {
    setError(null);
    setRows(null);
    setChosen(new Set());
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

  function extractSelected() {
    if (!rows || selected.length === 0) return;
    stopped.current = false;

    startRun(async () => {
      for (const index of selected) {
        if (stopped.current) {
          setRows((current) =>
            current!.map((row, i) =>
              selected.includes(i) && row.state === 'pending'
                ? { ...row, state: 'skipped', note: 'stopped' }
                : row
            )
          );
          return;
        }

        setRows((current) =>
          current!.map((row, i) => (i === index ? { ...row, state: 'running' } : row))
        );

        const result = await action({
          handle: rows[index].thread.handle,
          messages: rows[index].thread.messages,
        });

        setRows((current) =>
          current!.map((row, i) =>
            i === index
              ? { ...row, state: result.ok ? 'done' : 'failed', note: result.message }
              : row
          )
        );
      }
    });
  }

  const toggle = (index: number) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

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

        {rows && !running && (
          <>
            <button
              type="button"
              onClick={extractSelected}
              disabled={selected.length === 0}
              className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-40"
            >
              {selected.length === 0
                ? 'Select conversations to extract'
                : `Extract ${selected.length} selected`}
            </button>
            <button
              type="button"
              onClick={() => setChosen(new Set(rows.map((_, i) => i)))}
              className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
            >
              Select all ({rows.length})
            </button>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setChosen(new Set())}
                className="text-muted-foreground px-1 text-xs hover:underline"
              >
                clear
              </button>
            )}
          </>
        )}

        {running && (
          <button
            type="button"
            onClick={() => {
              stopped.current = true;
            }}
            className="border-destructive text-destructive rounded-md border px-3 py-1.5 text-sm"
          >
            Stop after this one
          </button>
        )}

        {filename && <span className="text-muted-foreground text-xs">{filename}</span>}
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      {rows && (
        <>
          <p className="text-muted-foreground text-xs">
            {rows.length} conversations of at least {minMessages} messages.
            {rows.filter((r) => r.thread.truncated).length > 0 &&
              ` ${rows.filter((r) => r.thread.truncated).length} trimmed to their most recent messages.`}{' '}
            {running
              ? `${done + failed} of ${selected.length} done.`
              : live
                ? 'Each one selected is a paid model call.'
                : 'Fake mode: each produces the same canned storyline.'}
          </p>

          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto text-xs">
            {rows.map((row, index) => (
              <li key={index} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={chosen.has(index)}
                  disabled={running}
                  onChange={() => toggle(index)}
                  className="shrink-0"
                  aria-label={`Extract ${row.thread.handle}`}
                />
                <span
                  className={cn(
                    'w-12 shrink-0',
                    row.state === 'failed' && 'text-destructive',
                    row.state === 'running' && 'font-medium',
                    (row.state === 'done' || row.state === 'skipped') && 'text-muted-foreground'
                  )}
                >
                  {row.state === 'pending' && ''}
                  {row.state === 'running' && '…'}
                  {row.state === 'done' && 'done'}
                  {row.state === 'failed' && 'failed'}
                  {row.state === 'skipped' && '—'}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.thread.handle}</span>
                <span className="text-muted-foreground shrink-0">
                  {row.thread.messages.length} msgs
                  {row.thread.truncated && ' · trimmed'}
                </span>
                {row.note && (
                  <span
                    className={cn(
                      'max-w-[45%] shrink-0 truncate',
                      row.state === 'failed' ? 'text-destructive' : 'text-muted-foreground/70'
                    )}
                  >
                    {row.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-muted-foreground/70 text-xs">
        The export is parsed in this page and never uploaded. Each conversation reaches the model as
        it is extracted; only the retelling is stored.
      </p>
    </div>
  );
}
