import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import * as storylines from '@/lib/services/storylines/storylines.service';
import * as sessions from '@/lib/services/sessions/sessions.service';
import * as timeline from '@/lib/services/timeline/timeline.service';
import { db } from '@/index';
import { ActionButton } from '@/components/lab/action-button';
import { chooseAction, generateTurnAction, startSessionAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function PlayPage({
  // A Promise in Next 16, unlike earlier versions.
  params,
}: {
  params: Promise<{ storylineId: string }>;
}) {
  const { storylineId } = await params;

  let userId: string;
  try {
    userId = (await requireLabUser()).id;
  } catch {
    notFound();
  }

  const storyline = await storylines.getStoryline(userId, storylineId).catch(() => null);
  if (!storyline) notFound();

  const [beats, cast, allSessions] = await Promise.all([
    timeline.listTimeline(storylineId),
    storylines.listCharacters(storylineId),
    sessions.listSessions(userId, storylineId),
  ]);

  const people = await db.query.persons.findMany({ where: { userId } });
  const nameOf = (personId: string) => people.find((p) => p.id === personId)?.name ?? '—';

  // The most recent session is the one being played; earlier ones are history.
  const current = allSessions.at(-1) ?? null;
  const openTurn = current ? await sessions.getOpenTurn(userId, current.id) : null;

  // A turn that offers nothing can never be answered, and because presenting a
  // beat is get-or-create against the one-open-turn index, it is also the last
  // turn this session will ever have. That is a finished playthrough rather than
  // a broken one — but it needs saying, and it needs a way forward, or the page
  // just sits there. The seed ships one of these at the end of every scripted
  // session, so it is the first thing anyone sees.
  const sessionEnded = openTurn !== null && openTurn.choices.length === 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/lab" className="text-muted-foreground text-xs hover:underline">
        ← all storylines
      </Link>

      <header className="mt-3 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{storyline.title}</h1>
        <p className="text-muted-foreground mt-1 text-xs">
          {storyline.status}
          {storyline.tone && ` · ${storyline.tone}`}
          {storyline.setting && ` · ${storyline.setting}`}
        </p>
        {storyline.arcSummary && (
          <p className="text-muted-foreground mt-3 text-sm italic">{storyline.arcSummary}</p>
        )}
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Cast</h2>
        <ul className="flex flex-wrap gap-2">
          {cast.map((character) => (
            <li
              key={character.id}
              className="border-border rounded-full border px-2.5 py-1 text-xs"
            >
              {nameOf(character.personId)}
              <span className="text-muted-foreground"> · {character.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium">
          Canon <span className="text-muted-foreground font-normal">({beats.length} beats)</span>
        </h2>
        <ol className="flex flex-col gap-3">
          {beats.map((beat) => (
            <li
              key={beat.id}
              className={
                beat.origin === 'conversation_generated'
                  ? 'border-foreground/30 border-l-2 pl-3'
                  : 'border-border border-l-2 pl-3'
              }
            >
              <div className="flex items-baseline gap-2">
                <span className="text-muted-foreground font-mono text-[11px]">
                  {beat.narrativeOrder}
                </span>
                <span className="text-sm font-medium">{beat.title}</span>
                {beat.origin === 'conversation_generated' && (
                  <span className="border-border text-muted-foreground rounded border px-1 text-[10px]">
                    you caused this
                  </span>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 text-sm">{beat.description}</p>
              {beat.generationRationale && (
                <p className="text-muted-foreground/70 mt-1 text-xs italic">
                  why: {beat.generationRationale}
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="border-border rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-medium">Play</h2>

        {storyline.status !== 'ready' && (
          <p className="text-muted-foreground text-xs">
            {storyline.status === 'generating'
              ? 'Still extracting. If the request that started this was interrupted, it will stay here — nothing marks it failed, because nothing is still running to do so. Delete it from the list.'
              : storyline.status === 'failed'
                ? `Extraction failed: ${storyline.failureReason ?? 'no reason recorded'}`
                : 'Not ready to play yet.'}
          </p>
        )}

        {storyline.status === 'ready' && !current && (
          <ActionButton
            action={startSessionAction.bind(null, storylineId)}
            label="Start a session"
            pendingLabel="Starting…"
            variant="primary"
          />
        )}

        {storyline.status === 'ready' && sessionEnded && (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed">{openTurn!.narrativeContent}</p>
            <p className="text-muted-foreground text-xs">
              This beat offered no choices, so the playthrough is over. Start another to keep going
              — canon carries across sessions.
            </p>
            <ActionButton
              action={startSessionAction.bind(null, storylineId)}
              label="Start another session"
              pendingLabel="Starting…"
              variant="primary"
            />
          </div>
        )}

        {storyline.status === 'ready' && current && !openTurn && (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">
              Session {current.id.slice(0, 8)} · no open turn
            </p>
            <ActionButton
              action={generateTurnAction.bind(null, current.id)}
              label="Generate the next beat"
              pendingLabel="Generating…"
              variant="primary"
            />
          </div>
        )}

        {storyline.status === 'ready' && current && openTurn && !sessionEnded && (
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed">{openTurn.narrativeContent}</p>
            <ul className="flex flex-col gap-2">
              {openTurn.choices.map((choice) => (
                <li key={choice.id}>
                  <ActionButton
                    action={chooseAction.bind(null, openTurn.id, choice.id)}
                    label={choice.label}
                    pendingLabel="Committing…"
                    className="text-left"
                  />
                  {choice.description && (
                    <p className="text-muted-foreground mt-0.5 ml-1 text-xs">
                      {choice.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {current && !sessionEnded && (
          <p className="text-muted-foreground mt-4 text-xs">
            {allSessions.length} session{allSessions.length === 1 ? '' : 's'} on this storyline;
            playing the most recent.{' '}
            <ActionButton
              action={startSessionAction.bind(null, storylineId)}
              label="Start a fresh one"
              pendingLabel="Starting…"
            />
          </p>
        )}
      </section>
    </main>
  );
}
