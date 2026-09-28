/**
 * Plays a real storyline against the real model and reports whether the
 * playhead actually changed the writing.
 *
 * The mechanical half is covered by tests. This answers the part no test can:
 * do the other characters now do things, or is the model still reading the
 * source conversation aloud?
 *
 * Starts a **fresh** session deliberately. A session restarted by the backfill
 * carries turns from before the change, and judging new behaviour against that
 * history confuses two different things.
 *
 *   doppler run -- pnpm tsx src/scripts/live-playthrough.ts "Under One Roof" 6
 */
import { db } from '@/index';
import { generatorMode } from '@/lib/ai';
import { requireLabUser } from '@/lib/services/auth/dev-user';
import {
  generateConsequences,
  generateTurn,
  commitChoice,
} from '@/lib/services/generation/turns.service';
import * as sessions from '@/lib/services/sessions/sessions.service';
import * as timeline from '@/lib/services/timeline/timeline.service';

const [match = 'Under One Roof', turnCount = '6'] = process.argv.slice(2);

/** Words too common to mean anything when they show up in both texts. */
const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'they',
  'them',
  'their',
  'you',
  'your',
  'her',
  'his',
  'him',
  'she',
  'he',
  'we',
  'us',
  'our',
  'not',
  'no',
  'yes',
  'up',
  'out',
  'who',
  'whose',
  'what',
  'when',
  'then',
  'now',
  'into',
  'over',
  'about',
  'after',
  'before',
  'more',
  'one',
  'first',
  'still',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'than',
  'so',
  'if',
  'can',
  'will',
  'would',
  'there',
  'here',
  'some',
]);

/**
 * Distinctive words only.
 *
 * A first pass at six characters and a threshold of four flagged six of six
 * turns, every one of them a false positive: a beat about a shared wall and a
 * turn about a shared wall collide on "shared", "room", "space" and a cast
 * member's name without one retelling the other. The bar is longer words, more
 * of them, and never a name.
 */
const keywords = (text: string, names: string[] = []) => {
  const banned = new Set(names.map((n) => n.toLowerCase()));
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 6 && !STOP.has(w) && !banned.has(w))
  );
};

async function main() {
  if (generatorMode() !== 'live') {
    console.error('Not in live mode — this can say nothing about prompt quality.');
    process.exit(2);
  }

  const user = await requireLabUser();
  const all = await db.query.storylines.findMany({ where: { userId: user.id } });
  const storyline = all.find((s) => s.title.toLowerCase().includes(match.toLowerCase()));
  if (!storyline) {
    console.error(`No storyline matching "${match}". Have: ${all.map((s) => s.title).join(', ')}`);
    process.exit(2);
  }

  const beats = await timeline.listTimeline(storyline.id);
  const extracted = beats.filter((b) => b.origin === 'extracted');
  console.log(`\n${storyline.title}`);
  console.log(`${extracted.length} extracted beats, ${beats.length} total\n`);

  const people = await db.query.persons.findMany({ where: { userId: user.id } });
  const castNames = people.map((p) => p.name);

  const session = await sessions.startSession(user.id, storyline.id);
  console.log(`fresh session, playhead ${session.playheadOrder}\n`);

  let leaks = 0;
  const generatedTitles: string[] = [];

  for (let i = 0; i < Number(turnCount); i += 1) {
    const before = await sessions.getSession(user.id, session.id);
    const turn = await generateTurn(user.id, session.id, {});

    const visible = beats.filter((b) => b.narrativeOrder <= before.playheadOrder).length;
    console.log(
      `── turn ${turn.turnOrder}  [playhead ${before.playheadOrder}, ${visible}/${beats.length} beats visible]`
    );
    console.log(`   ${turn.narrativeContent}`);
    turn.choices.forEach((c, n) => console.log(`     ${n + 1}. ${c.label}`));

    // Did it narrate a beat the reader has not reached? Keyword overlap is
    // crude, but the failure it looks for was blatant — whole beats retold
    // almost verbatim, dates and all.
    const ahead = extracted.filter((b) => b.narrativeOrder > before.playheadOrder);
    const said = keywords(turn.narrativeContent, castNames);
    for (const beat of ahead) {
      const beatWords = keywords(`${beat.title} ${beat.description}`, castNames);
      const shared = [...beatWords].filter((w) => said.has(w));
      if (shared.length >= 6) {
        leaks += 1;
        console.log(
          `   ⚠ overlaps unreached beat ${beat.narrativeOrder} "${beat.title}": ${shared.join(', ')}`
        );
      }
    }

    await commitChoice(user.id, turn.id, turn.choices[0].id);
    const consequences = await generateConsequences(user.id, turn.id, {});
    const after = await sessions.getSession(user.id, session.id);
    console.log(
      `   → chose "${turn.choices[0].label}"  ·  ${consequences.events} beat(s), ${consequences.contextEntries} background, ${consequences.relationshipStates} state(s)  ·  playhead ${after.playheadOrder}\n`
    );

    const fresh = await db.query.events.findMany({ where: { triggeredByTurnId: turn.id } });
    generatedTitles.push(...fresh.map((e) => e.title));
  }

  const self = people.find((p) => p.isSelf);
  const aboutSelf = generatedTitles.filter((t) =>
    self ? t.toLowerCase().startsWith(self.name.toLowerCase()) : false
  ).length;

  console.log('═'.repeat(60));
  console.log(`beats written this run: ${generatedTitles.length}`);
  generatedTitles.forEach((t) => console.log(`   ${t}`));
  console.log(`\nof those, titled with the protagonist: ${aboutSelf}/${generatedTitles.length}`);
  console.log(`turns overlapping an unreached beat: ${leaks}`);
  console.log(`\nstoryline: http://localhost:3000/lab/${storyline.id}`);
}

main().catch((error) => {
  console.error('\nCRASHED:', error);
  process.exit(1);
});
