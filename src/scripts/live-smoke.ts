/**
 * Drives the whole pipeline once, against the real model and the real database.
 *
 * The integration suite already proves the service layer, but it runs on the
 * fake generator — so it cannot see anything that only the provider rejects.
 * That class of bug is real and has shipped here before: a prompt whose schema
 * name contained a dot passed every mocked test and would have failed every
 * live call. Only a live pass through all four prompts can say the pipeline
 * works.
 *
 * Runs as the seed user, so whatever it produces is visible and playable in
 * /lab and deletable from there.
 *
 *   doppler run -- pnpm tsx src/scripts/live-smoke.ts
 */
import { db } from '@/index';
import { generatorMode } from '@/lib/ai';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import { extractStoryline } from '@/lib/services/generation/extraction.service';
import {
  generateConsequences,
  generateTurn,
  commitChoice,
} from '@/lib/services/generation/turns.service';
import { summarizeArc } from '@/lib/services/generation/arc.service';
import * as sessions from '@/lib/services/sessions/sessions.service';
import { movingWeekend } from '@/lib/services/generation/__fixtures__/transcripts';

const FAKE_TELL = 'what began unsaid is now partly said';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function stage(n: number, name: string) {
  console.log(`\n── ${n}. ${name} ${'─'.repeat(Math.max(0, 46 - name.length))}`);
}

async function main() {
  console.log(`\nmode: ${generatorMode()}`);
  if (generatorMode() !== 'live') {
    console.error('\nNot in live mode. This probe is worthless against the fake.');
    process.exit(2);
  }

  const user = await requireLabUser();
  const t0 = Date.now();

  // ── 1. Extraction ──────────────────────────────────────────────
  stage(1, 'extract a three-person group chat');
  const storyline = await extractStoryline(user.id, movingWeekend);
  const full = await db.query.storylines.findFirst({
    where: { id: storyline.id },
    with: { events: true, characters: { with: { person: true } }, contextEntries: true },
  });

  check(
    'status is ready',
    full?.status === 'ready',
    `got "${full?.status}" ${full?.failureReason ?? ''}`
  );
  check('title was written', !!full?.title && full.title !== 'Untitled', `"${full?.title}"`);
  check('setting was written', !!full?.setting);
  check('beats were extracted', (full?.events.length ?? 0) > 0, `${full?.events.length} beats`);
  check(
    'beats carry occurredAt',
    (full?.events.filter((e) => e.occurredAt).length ?? 0) > 0,
    `${full?.events.filter((e) => e.occurredAt).length}/${full?.events.length} dated`
  );
  check(
    'narrative_order is gapped',
    new Set(full?.events.map((e) => e.narrativeOrder)).size === full?.events.length
  );

  const cast = (full?.characters ?? []).map((c) => c.person.name);
  // The group-chat fix: all three speakers must survive as distinct people.
  check('all three speakers were cast', cast.length >= 3, `cast: ${cast.join(', ')}`);
  check(
    'the third speaker was not dropped',
    cast.some((n) => /nathaly/i.test(n)),
    `cast: ${cast.join(', ')}`
  );
  check('speakers did not merge into one person', new Set(cast).size === cast.length);

  // ── 2. Session ─────────────────────────────────────────────────
  stage(2, 'start a session');
  const session = await sessions.startSession(user.id, storyline.id);
  check('session opened', !!session.id);
  const firstBeat = Math.min(...(full?.events ?? []).map((e) => e.narrativeOrder));
  check(
    'the playhead starts at the first beat, not the end of the story',
    session.playheadOrder === firstBeat,
    `playhead ${session.playheadOrder}, first beat ${firstBeat}`
  );

  // ── 3. Turn one ────────────────────────────────────────────────
  stage(3, 'generate turn 1');
  const turn1 = await generateTurn(user.id, session.id);
  check('narrative was written', turn1.narrativeContent.trim().length > 0);
  check('choices were offered', turn1.choices.length >= 2, `${turn1.choices.length} choices`);
  check(
    'choices are distinct',
    new Set(turn1.choices.map((c) => c.label)).size === turn1.choices.length
  );
  console.log(
    `\n    "${turn1.narrativeContent.slice(0, 240)}${turn1.narrativeContent.length > 240 ? '…' : ''}"`
  );
  turn1.choices.forEach((c, i) => console.log(`      ${i + 1}. ${c.label}`));

  // ── 4. Answer ──────────────────────────────────────────────────
  stage(4, 'answer the turn');
  const before = (await sessions.getSession(user.id, session.id)).lastActiveAt;
  const answered = await commitChoice(user.id, turn1.id, turn1.choices[0].id);
  const after = (await sessions.getSession(user.id, session.id)).lastActiveAt;
  check('the choice was recorded', answered.selectedChoiceId === turn1.choices[0].id);
  check('lastActiveAt moved', after > before);
  const moved = await sessions.getSession(user.id, session.id);
  check(
    'the playhead moved on',
    moved.playheadOrder >= session.playheadOrder,
    `${session.playheadOrder} -> ${moved.playheadOrder}`
  );

  // ── 5. Consequences ────────────────────────────────────────────
  stage(5, 'work out what the decision changed');
  const beatsBefore = full?.events.length ?? 0;
  const consequences = await generateConsequences(user.id, turn1.id);
  console.log(
    `    ${consequences.events} beat(s), ${consequences.contextEntries} background, ${consequences.relationshipStates} relationship state(s)`
  );

  const afterCons = await db.query.storylines.findFirst({
    where: { id: storyline.id },
    with: { events: true, contextEntries: true },
  });
  const generated = (afterCons?.events ?? []).filter((e) => e.origin === 'conversation_generated');
  check(
    'durable beats match the report',
    (afterCons?.events.length ?? 0) === beatsBefore + consequences.events
  );
  if (consequences.events > 0) {
    check(
      'generated beats carry their lineage',
      generated.every((e) => e.triggeredByTurnId === turn1.id)
    );
    check(
      'generated beats carry a rationale',
      generated.every((e) => !!e.generationRationale)
    );
  }

  // Idempotence is a claimed property of this function, so prove it rather than
  // trust it: a retry must neither append nor pay for a second generation.
  if (consequences.events > 0) {
    const covering = await sessions.getSession(user.id, session.id);
    const newest = Math.max(...generated.map((e) => e.narrativeOrder));
    check(
      'the reader can see the beat their own choice caused',
      covering.playheadOrder >= newest,
      `playhead ${covering.playheadOrder}, beat at ${newest}`
    );
  }

  const replay = await generateConsequences(user.id, turn1.id);
  const afterReplay = await db.query.storylines.findFirst({
    where: { id: storyline.id },
    with: { events: true },
  });
  check(
    'retrying consequences writes nothing new',
    (afterReplay?.events.length ?? 0) === (afterCons?.events.length ?? 0),
    `replay reported ${replay.events} beats`
  );

  // ── 6. Turn two ────────────────────────────────────────────────
  stage(6, 'generate turn 2');
  const turn2 = await generateTurn(user.id, session.id);
  check('a second turn opened', turn2.id !== turn1.id);
  check(
    'turn order advanced',
    turn2.turnOrder > turn1.turnOrder,
    `${turn1.turnOrder} → ${turn2.turnOrder}`
  );
  check('the second turn has choices', turn2.choices.length >= 2);

  // ── 7. Arc ─────────────────────────────────────────────────────
  stage(7, 'summarise the arc');
  const outcome = await summarizeArc(user.id, storyline.id);
  const summarised = await db.query.storylines.findFirst({ where: { id: storyline.id } });
  check('the arc was summarised', outcome === 'written', `outcome: ${outcome}`);
  check('a summary is stored', !!summarised?.arcSummary);
  check('the summary is not the fake fixture', !summarised?.arcSummary?.includes(FAKE_TELL));
  check('the watermark was stamped', !!summarised?.arcSummaryGeneratedAt);
  console.log(`\n    "${summarised?.arcSummary ?? ''}"`);

  const second = await summarizeArc(user.id, storyline.id);
  check('a second sweep finds it current', second === 'already-current', `outcome: ${second}`);

  console.log(`\n${'═'.repeat(56)}`);
  console.log(
    failures === 0
      ? `ALL CHECKS PASSED in ${Math.round((Date.now() - t0) / 1000)}s`
      : `${failures} CHECK(S) FAILED`
  );
  console.log(`storyline: ${storyline.id}`);
  console.log(`open it:   http://localhost:3000/lab/${storyline.id}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nPROBE CRASHED:', error);
  process.exit(1);
});
