/**
 * Plays one of the team's seed stories against the real model, the way a reader
 * would, and prints every beat with what each model call cost in time and
 * tokens. Reads like a playthrough, so continuity can be judged; times like a
 * benchmark, so the wait can be.
 *
 * Production is the only place with the real model and nothing else to test
 * on, so it is safe to run there: it makes its own throwaway admin account
 * (unlimited energy, usage data off), plays a seed story, never a player's, and
 * deletes the account and everything it wrote when it's done, even on failure.
 *
 *   porter app run bramble -- node dist/scripts/play-through.js [beats] [order] [seed]
 *
 *   beats   how many beats to play, 10 by default
 *   order   `after`  consequences settled after each beat (the new order)
 *           `before` consequences settled before it (the order before
 *                    2026-11-25, kept to compare against)
 *           `both`   the same story both ways, one after the other (default)
 *   seed    a seed story's slug, `summer-shift` by default
 *
 * Choices are picked by position (the first, then the second, ...), the same
 * in both orders, though the stories drift apart as the model writes them.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/index';
import { storyTemplates, users } from '@/db/schema/tables';
import { getGenerator, type Generator } from '@/lib/ai';
import type { GenerationMeta } from '@/lib/ai/prompt';
import { SEED_STORIES } from '@/lib/pool/seeds';
import { surfaceHistoryLine } from '@/lib/surfaces';
import { instantiateTemplate } from '@/lib/services/pool/next.service';
import {
  advanceSession,
  commitChoice,
  settleConsequences,
} from '@/lib/services/generation/turns.service';
import { findTurnsOwedConsequences } from '@/lib/services/sessions/sessions.reader';

type Order = 'after' | 'before';

const [beatsArg = '10', orderArg = 'both', slug = 'summer-shift'] = process.argv.slice(2);
const BEATS = Number(beatsArg);
const ORDERS: Order[] = orderArg === 'both' ? ['after', 'before'] : [orderArg as Order];

/** The real generator, keeping each call's numbers so a beat can show them. */
function recording(real: Generator, calls: GenerationMeta[]): Generator {
  return {
    async run(spec, vars, opts) {
      const result = await real.run(spec, vars, opts);
      calls.push(result.meta);
      return result;
    },
    async stream(spec, vars, opts) {
      const result = await real.stream(spec, vars, opts);
      calls.push(result.meta);
      return result;
    },
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

function describeCall(meta: GenerationMeta): string {
  const stage = meta.promptName.split('.')[0];
  return (
    `${stage} ${seconds(meta.durationMs)} ` +
    `(in ${meta.inputTokens}, cached ${meta.cachedInputTokens}, written ${meta.cacheWriteTokens}, ` +
    `out ${meta.outputTokens}, thinking ${meta.reasoningTokens})`
  );
}

async function play(order: Order, templateId: string, owners: string[]): Promise<number[]> {
  const [user] = await db
    .insert(users)
    .values({
      clerkId: `playthrough_${crypto.randomUUID()}`,
      email: `playthrough+${Date.now()}@brambleworld.invalid`,
      role: 'admin',
      shareUsage: false,
    })
    .returning({ id: users.id });
  owners.push(user.id);

  const sessionId = await db.transaction((tx) =>
    instantiateTemplate(tx, user.id, templateId, SEED_STORIES[slug])
  );

  console.log(`\n${'═'.repeat(64)}\n${slug}, consequences ${order} the beat\n${'═'.repeat(64)}`);

  const waits: number[] = [];
  const real = getGenerator();
  for (let n = 1; n <= BEATS; n++) {
    const calls: GenerationMeta[] = [];
    const generator = recording(real, calls);
    let pending: (() => Promise<void>) | null = null;

    const started = Date.now();
    // The old order, for comparison: what's owed is settled first, inside the wait.
    if (order === 'before') {
      for (const owed of await findTurnsOwedConsequences(db, sessionId)) {
        await settleConsequences(user.id, owed.id, { generator });
      }
    }
    const turn = await advanceSession(user.id, sessionId, {
      generator,
      later: (work) => {
        pending = work;
      },
    });
    const waited = Date.now() - started;
    waits.push(waited);

    console.log(`\n${n}. ${turn.headline ?? '(no headline)'}`);
    turn.surfaces.forEach((surface) => console.log(`   ${surfaceHistoryLine(surface)}`));
    console.log(`   ${turn.narrativeContent}`);
    turn.choices.forEach((c, i) => console.log(`     ${i + 1}. ${c.label}`));
    console.log(`   waited ${seconds(waited)}: ${calls.map(describeCall).join('; ') || 'no call'}`);

    // What the reader would not wait for, timed on its own.
    if (pending) {
      const before = calls.length;
      await (pending as () => Promise<void>)();
      const after = calls.slice(before);
      if (after.length)
        console.log(`   then, after the beat: ${after.map(describeCall).join('; ')}`);
    }

    if (turn.isEnding || !turn.choices.length) {
      console.log('   (the end)');
      break;
    }
    const pick = turn.choices[(n - 1) % turn.choices.length];
    console.log(`   → ${pick.label}`);
    await commitChoice(user.id, turn.id, pick.id);
  }

  console.log(`\nmedian wait, consequences ${order}: ${seconds(median(waits))}`);
  return waits;
}

async function main() {
  if (!Number.isInteger(BEATS) || BEATS < 1) throw new Error('beats must be a whole number');
  if (!ORDERS.every((o) => o === 'after' || o === 'before')) {
    throw new Error('order must be after, before or both');
  }
  if (!SEED_STORIES[slug]) {
    throw new Error(`no seed story "${slug}": ${Object.keys(SEED_STORIES).join(', ')}`);
  }
  const [template] = await db
    .select({ id: storyTemplates.id })
    .from(storyTemplates)
    .where(eq(storyTemplates.slug, slug));
  if (!template) throw new Error(`seed story "${slug}" is not in this database`);

  const owners: string[] = [];
  const results = new Map<Order, number[]>();
  try {
    for (const order of ORDERS) results.set(order, await play(order, template.id, owners));
  } finally {
    // Everything it wrote cascades from the account.
    if (owners.length) await db.delete(users).where(inArray(users.id, owners));
  }

  if (results.size > 1) {
    console.log(`\n${'═'.repeat(64)}`);
    for (const [order, waits] of results) {
      console.log(`median wait, consequences ${order}: ${seconds(median(waits))}`);
    }
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('play-through failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
