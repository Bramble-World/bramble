import Link from 'next/link';
import type { Metadata } from 'next';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import * as storylines from '@/lib/services/storylines/storylines.service';
import { db } from '@/index';
import { ActionButton } from '@/components/lab/action-button';
import { UploadTranscript } from '@/components/lab/upload-transcript';
import { extractAction, extractFromUploadAction, sweepAction } from './actions';

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

  const all = await storylines.listStorylines(userId);

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
          Runs the generation pipeline against real rows. Set{' '}
          <code className="bg-muted rounded px-1">BRAMBLE_AI_MODE=fake</code> to play without
          spending anything.
        </p>
      </header>

      <section className="border-border mb-6 rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-medium">Extract from your own messages</h2>
        <p className="text-muted-foreground mb-3 text-xs">
          The whole export goes in as one conversation.
        </p>
        <UploadTranscript action={extractFromUploadAction} />
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

      <h2 className="mb-3 text-sm font-medium">Storylines ({rows.length})</h2>
      <ul className="flex flex-col gap-2">
        {rows.map(({ storyline, beats, generated, sessions, cast }) => (
          <li key={storyline.id}>
            <Link
              href={`/lab/${storyline.id}`}
              className="border-border hover:bg-muted block rounded-lg border p-4 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{storyline.title}</span>
                <StatusBadge status={storyline.status} />
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
