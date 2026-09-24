import Link from 'next/link';
import type { Metadata } from 'next';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import * as storylines from '@/lib/services/storylines/storylines.service';
import { db } from '@/index';
import { generatorMode } from '@/lib/ai';
import { ActionButton } from '@/components/lab/action-button';
import { ImportExport } from '@/components/lab/import-export';
import {
  clearExtractedAction,
  deleteStorylineAction,
  extractAction,
  extractThreadAction,
  sweepAction,
} from './actions';
import { MAX_TRANSCRIPT_CHARS, MIN_THREAD_MESSAGES } from '@/lib/services/generation/limits';

export const metadata: Metadata = {
  title: 'Bramble — lab',
  // Never meant to be found. It acts as a fixed user and only runs in
  // development, but there is no reason to advertise it either.
  robots: { index: false, follow: false },
};

/** Always fresh: the whole point is watching rows change as the pipeline runs. */
export const dynamic = 'force-dynamic';

export default async function LabPage() {
  let userId: string;
  try {
    userId = (await requireLabUser()).id;
  } catch (error) {
    return <Unavailable message={error instanceof Error ? error.message : 'Unavailable'} />;
  }

  const mode = generatorMode();
  const all = await storylines.listStorylines(userId);

  // The seed writes in one transaction, so its storylines all share an identical
  // created_at and the earliest such instant identifies that batch. Anything
  // later was extracted afterwards — by an import, a fixture button, or a test
  // run against this same database. A harness-grade signal rather than real
  // provenance, which would need a column; good enough to navigate by, and
  // labelled so nobody mistakes it for more than it is.
  const seededAt = all.reduce<Date | null>(
    (earliest, s) => (!earliest || s.createdAt < earliest ? s.createdAt : earliest),
    null
  );

  // Counts for the list, read directly because this is a harness and a service
  // method returning "how many beats" exists for nothing else.
  const rows = await Promise.all(
    all.map(async (storyline) => {
      const full = await db.query.storylines.findFirst({
        where: { id: storyline.id },
        with: { events: true, sessions: true, characters: true },
      });
      return {
        storyline,
        seeded: seededAt !== null && storyline.createdAt.getTime() === seededAt.getTime(),
        beats: full?.events.length ?? 0,
        generated: full?.events.filter((e) => e.origin === 'conversation_generated').length ?? 0,
        sessions: full?.sessions.length ?? 0,
        cast: full?.characters.length ?? 0,
      };
    })
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Lab</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Runs the generation pipeline against real rows.
        </p>
        <ModeBanner mode={mode} />
      </header>

      <section className="border-border mb-6 rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-medium">Extract from your own messages</h2>
        <p className="text-muted-foreground mb-3 text-xs">
          Every conversation in the file becomes its own storyline. People are matched across them,
          so the same person is the same person everywhere.
        </p>
        <ImportExport
          action={extractThreadAction}
          minMessages={MIN_THREAD_MESSAGES}
          maxChars={MAX_TRANSCRIPT_CHARS}
          live={mode === 'live'}
        />
      </section>

      <section className="border-border mb-8 rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-medium">Fixtures</h2>
        <div className="flex flex-col gap-3">
          <ActionButton
            action={extractAction.bind(null, 'unsent-apology')}
            label="Extract · the unsent apology"
            pendingLabel="Extracting…"
          />
          <ActionButton
            action={extractAction.bind(null, 'three-weeks-later')}
            label="Extract · three weeks later (same person)"
            pendingLabel="Extracting…"
          />
          <ActionButton action={sweepAction} label="Run the arc sweep" pendingLabel="Sweeping…" />
        </div>
      </section>

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          Storylines ({rows.length}){' '}
          <span className="text-muted-foreground font-normal">
            · {rows.filter((r) => r.seeded).length} seeded · {rows.filter((r) => !r.seeded).length}{' '}
            extracted
          </span>
        </h2>
        {rows.some((r) => !r.seeded) && (
          <ActionButton
            action={clearExtractedAction}
            label="Clear extracted"
            pendingLabel="Clearing…"
          />
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map(({ storyline, seeded, beats, generated, sessions, cast }) => (
          <li key={storyline.id} className="border-border rounded-lg border">
            <Link
              href={`/lab/${storyline.id}`}
              className="hover:bg-muted block rounded-t-lg p-4 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{storyline.title}</span>
                <span className="flex shrink-0 items-baseline gap-1.5">
                  <Origin seeded={seeded} />
                  <StatusBadge status={storyline.status} />
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                {cast} cast · {beats} beats{generated > 0 && ` (${generated} generated)`} ·{' '}
                {sessions} session{sessions === 1 ? '' : 's'}
                {storyline.tone && ` · ${storyline.tone}`}
              </p>
              {storyline.arcSummary && (
                <p className="text-muted-foreground mt-2 text-sm italic">{storyline.arcSummary}</p>
              )}
              {storyline.failureReason && (
                <p className="text-destructive mt-2 text-xs">{storyline.failureReason}</p>
              )}
            </Link>
            <div className="border-border flex items-center justify-between gap-2 border-t px-4 py-2">
              <span className="text-muted-foreground/70 text-[11px]">
                {storyline.createdAt.toLocaleString()}
              </span>
              {!seeded && (
                <ActionButton
                  action={deleteStorylineAction.bind(null, storyline.id)}
                  label="Delete"
                  pendingLabel="Deleting…"
                />
              )}
            </div>
          </li>
        ))}
      </ul>

      {rows.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Nothing yet. Extract one above, or run <code>pnpm db:seed</code>.
        </p>
      )}
    </main>
  );
}

/**
 * Says whether generating costs money, because nothing else does.
 *
 * The two modes produce output that looks alike — the fake returns a plausible
 * storyline, not an obvious placeholder — so the only way to tell them apart
 * without this is to remember how the server was started.
 */
function ModeBanner({ mode }: { mode: 'live' | 'fake' }) {
  return (
    <div
      className={
        mode === 'live'
          ? 'border-foreground/40 bg-muted mt-3 rounded-md border px-3 py-2 text-xs'
          : 'border-border mt-3 rounded-md border px-3 py-2 text-xs'
      }
    >
      {mode === 'live' ? (
        <>
          <span className="font-medium">Live.</span> Every generation is a paid call against the
          real model, and transcripts you import reach it. Restart with{' '}
          <code className="bg-background rounded px-1">BRAMBLE_AI_MODE=fake pnpm dev:doppler</code>{' '}
          to stop that.
        </>
      ) : (
        <>
          <span className="font-medium">Fake.</span> Nothing reaches a model and nothing is spent —
          but every storyline is the same canned fixture whatever you import, so titles will repeat.
          Restart with <code className="bg-background rounded px-1">pnpm dev:doppler</code> for real
          output.
        </>
      )}
    </div>
  );
}

function Origin({ seeded }: { seeded: boolean }) {
  return (
    <span
      className={
        seeded
          ? 'border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[11px]'
          : 'border-foreground/40 shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium'
      }
    >
      {seeded ? 'seed' : 'extracted'}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[11px]">
      {status}
    </span>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Lab</h1>
      <p className="text-destructive mt-2 text-sm">{message}</p>
    </main>
  );
}
