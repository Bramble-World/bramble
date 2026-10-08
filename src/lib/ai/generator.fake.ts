import { createHash } from 'node:crypto';
import { InternalServerError } from '@/lib/utils/errors';
import { STAGE_MODELS } from './models';
import { Generator, GenerationResult, PromptSpec } from './prompt';

/** What a fixture is handed: the prompt's own vars, plus a stable seed. */
export type FixtureContext<Vars> = {
  vars: Vars;
  /**
   * A number derived from the vars. Same input, same value, across runs and
   * machines — so a fixture can vary its output by input without becoming
   * unreproducible. Useful for picking between a few canned beats.
   */
  seed: number;
};

// A fixture is registered against a prompt whose Vars and Out are known only at
// the call site, so the registry is intentionally loose here and re-typed by
// `register`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFixture = (context: FixtureContext<any>) => unknown;

export type RecordedCall = {
  promptName: string;
  vars: unknown;
  system: string;
  prompt: string;
};

export interface FakeGenerator extends Generator {
  /** Supplies the canned output for one prompt. */
  register<Vars, Out>(
    spec: PromptSpec<Vars, Out>,
    fixture: (context: FixtureContext<Vars>) => Out
  ): void;
  /** Every call made, in order — this is what tests assert the context against. */
  readonly calls: RecordedCall[];
  reset(): void;
}

/**
 * A generator that never calls a model.
 *
 * This is the reason the whole pipeline is runnable in CI, where there is no key
 * and no budget, and in tests, where a network call would make the suite slow
 * and flaky. It is also how the harness in a later PR can play a storyline
 * through without spending anything.
 *
 * Faking at *this* boundary rather than at the model is deliberate. A fake
 * `LanguageModelV3` has to produce provider wire format — content parts, finish
 * reasons, and structured output through a mechanism that differs by provider
 * and by SDK version. Tests written against that are testing the SDK's parser,
 * not Bramble, and they rot whenever it changes: `generateObject` being
 * deprecated in the version we just installed is exactly that happening.
 *
 * The load-bearing property is the validation below. Fixtures are checked
 * against `spec.schema` — the same schema production parses with — so a schema
 * change that a fixture no longer satisfies fails loudly in CI instead of
 * letting the fake and the real client drift apart silently. A fake that can
 * return something production could not is worse than no fake.
 */
export function createFakeGenerator(): FakeGenerator {
  const fixtures = new Map<string, AnyFixture>();
  const calls: RecordedCall[] = [];

  return {
    calls,

    register(spec, fixture) {
      fixtures.set(spec.name, fixture as AnyFixture);
    },

    reset() {
      fixtures.clear();
      calls.length = 0;
    },

    async run<Vars, Out>(spec: PromptSpec<Vars, Out>, vars: Vars): Promise<GenerationResult<Out>> {
      const fixture = fixtures.get(spec.name);
      if (!fixture) {
        throw new InternalServerError(`No fake fixture registered for the prompt "${spec.name}"`);
      }

      // Rendering even though nothing reads the text: a prompt that throws while
      // building its string is a real bug, and the fake would otherwise hide it
      // until the first live call. It also gives tests the rendered text.
      const { system, prompt } = spec.render(vars);
      calls.push({ promptName: spec.name, vars, system, prompt });

      const produced = fixture({ vars, seed: seedFrom(vars) });

      // The whole point. Production parses model output through this schema, so
      // a fixture that would not survive it is not a stand-in for anything.
      const parsed = spec.schema.safeParse(produced);
      if (!parsed.success) {
        throw new InternalServerError(
          `The fake fixture for "${spec.name}" does not satisfy its own schema: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')}`
        );
      }

      return {
        value: parsed.data,
        meta: {
          promptName: spec.name,
          model: `fake:${STAGE_MODELS[spec.stage].model}`,
          inputTokens: 0,
          outputTokens: 0,
          finishReason: 'stop',
          durationMs: 0,
        },
      };
    },
  };
}

/** Stable across runs and machines, unlike a hash of an object's iteration order. */
function seedFrom(vars: unknown): number {
  const canonical = JSON.stringify(vars, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b)))
      : value
  );
  const digest = createHash('sha256')
    .update(canonical ?? '')
    .digest();
  return digest.readUInt32BE(0);
}
