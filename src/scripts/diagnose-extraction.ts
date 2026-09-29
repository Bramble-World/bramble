/**
 * Reproduces an extraction failure and prints what the database cannot hold.
 *
 * `translate()` attaches the real error as `cause` and deliberately keeps the
 * stored message generic, because provider bodies can echo the prompt. That is
 * right for production and useless for diagnosis, so this walks the chain.
 *
 *   doppler run -- pnpm tsx src/scripts/diagnose-extraction.ts [messages] [days]
 */
import { getGenerator, generatorMode } from '@/lib/ai';
import { beatTarget, extractionPrompt, MAX_BEATS } from '@/lib/ai/prompts/extraction.prompt';
import type { TranscriptMessage } from '@/lib/ai/prompts/extraction.prompt';

const [count = '700', days = '120'] = process.argv.slice(2);

const SPEAKERS = ['Andi', 'Nathaly', 'Favor', 'Great'];
const SUBJECTS = [
  'the landlord',
  'the deposit',
  'the table seller',
  'the van',
  'the boiler',
  'my sister',
  'the storage unit',
  'the bathroom rota',
  'the wifi contract',
  'the missing keys',
  'the parking permit',
  'the council letter',
  'the bins',
  'the shared spreadsheet',
  'the electricity meter',
  'the fire inspection',
];
const VERBS = [
  'still has not replied about',
  'wants a decision on',
  'is refusing to budge on',
  'has gone quiet about',
  'sent a bill for',
  'changed their mind about',
  'needs someone to sign for',
  'is threatening to charge us for',
  'offered to handle',
  'has no idea about',
];
const TAILS = [
  'and I am not paying for it twice',
  'before friday apparently',
  'which nobody mentioned',
  'so that is another eighty pounds',
  'and honestly I have stopped caring',
  'but only if we decide today',
  'which is exactly what I said last month',
  'and now it is my problem',
];
const LINES = SUBJECTS.flatMap((s) => VERBS.map((v, i) => `${v} ${s} ${TAILS[i % TAILS.length]}`));

function build(n: number, spanDays: number): TranscriptMessage[] {
  const start = Date.UTC(2026, 4, 1);
  const step = (spanDays * 86_400_000) / Math.max(1, n - 1);
  return Array.from({ length: n }, (_, i) => ({
    isFromMe: i % 3 === 0,
    handle: 'Flat 4B',
    sender: i % 3 === 0 ? 'me' : SPEAKERS[i % SPEAKERS.length],
    text: LINES[i % LINES.length],
    sentAt: new Date(start + i * step).toISOString(),
  }));
}

function chain(error: unknown, depth = 0): void {
  const pad = '  '.repeat(depth + 1);
  if (!(error instanceof Error)) {
    console.log(`${pad}(non-error) ${String(error)}`);
    return;
  }
  console.log(`${pad}${error.name}: ${error.message}`);
  // The AI SDK's NoObjectGeneratedError carries exactly what tells truncation
  // apart from a schema violation.
  for (const key of ['finishReason', 'usage', 'text'] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const shown = typeof value === 'string' ? value.slice(-400) : JSON.stringify(value);
    console.log(`${pad}  ${key}: ${shown}`);
  }
  if (error.cause) chain(error.cause, depth + 1);
}

async function main() {
  if (generatorMode() !== 'live') {
    console.error('Not live — this cannot reproduce a provider failure.');
    process.exit(2);
  }

  const messages = build(Number(count), Number(days));
  console.log(`\n  ${messages.length} messages over ${days} days`);
  console.log(`  beatTarget asks for ${beatTarget(messages)} beats (ceiling ${MAX_BEATS})`);
  console.log(
    `  prompt is roughly ${Math.round(JSON.stringify(messages).length / 1000)}KB of transcript\n`
  );

  try {
    const { value, meta } = await getGenerator().run(extractionPrompt, {
      user: { userId: 'diag', self: { id: 'self', name: 'Blossom' }, persons: [], motifs: [] },
      surface: 'imessage',
      messages,
    });
    console.log('  SUCCEEDED');
    console.log(`  beats returned: ${value.beats.length}, cast: ${value.cast.length}`);
    console.log(`  cast missing a want: ${value.cast.filter((c) => !c.want).length}`);
    console.log(
      `  tokens in/out: ${meta.inputTokens}/${meta.outputTokens}  finish: ${meta.finishReason}`
    );
    // The number that actually decides whether this works. Nothing streams, so
    // no response header arrives until the whole object exists, and Node's
    // fetch abandons the request at 300s.
    const seconds = meta.durationMs / 1000;
    console.log(
      `  took ${seconds.toFixed(0)}s — client gives up at 300s (${(300 - seconds).toFixed(0)}s margin)`
    );
  } catch (error) {
    console.log('  FAILED. Cause chain:\n');
    chain(error);
  }
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
