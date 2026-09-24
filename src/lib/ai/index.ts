import { env } from '@/env';
import { createFakeGenerator, FakeGenerator } from './generator.fake';
import { registerFixtures } from './fixtures';
import { createOpenAIGenerator } from './generator.openai';
import { Generator } from './prompt';

export type { Generator, GenerationResult, GenerationMeta, PromptSpec } from './prompt';
export type { FakeGenerator, FixtureContext, RecordedCall } from './generator.fake';
export { createFakeGenerator } from './generator.fake';
export { STAGE_MODELS, DEFAULT_MODEL } from './models';
export type { StageName, ReasoningEffort } from './models';

let live: Generator | null = null;
let fake: FakeGenerator | null = null;

/**
 * The generator this process should use.
 *
 * Falls back to the fake when there is no key, rather than throwing. CI runs
 * every gate with no secrets at all and the `Database` job drives the pipeline
 * against a real schema — so the fake has to be the automatic choice, not an
 * opt-in flag someone has to remember to set. An explicit `BRAMBLE_AI_MODE=fake`
 * forces it even when a key exists, which is how the loop gets played end to end
 * without spending anything.
 *
 * Both are memoised: the live client holds a connection pool, and the fake holds
 * its registered fixtures, so handing out a new one per call would quietly lose
 * them.
 */
export function getGenerator(): Generator {
  if (env.BRAMBLE_AI_MODE === 'fake' || !env.OPENAI_API_KEY) {
    // Fixtures are registered here rather than by each caller, because a fake
    // with none is not a working generator — it throws on the first prompt it
    // sees. Every route to the fake inside the app goes through this function,
    // so registering anywhere else means some path gets a generator that cannot
    // generate. Tests build their own fake explicitly and register what they
    // need, so this does not reach them.
    return (fake ??= withFixtures(createFakeGenerator()));
  }
  return (live ??= createOpenAIGenerator(env.OPENAI_API_KEY));
}

/**
 * The fake, for registering fixtures against.
 *
 * Throws when the process is configured to use the real client, so a test that
 * quietly stopped faking — and started spending — fails instead of passing.
 */
export function getFakeGenerator(): FakeGenerator {
  const generator = getGenerator();
  if (generator !== fake) {
    throw new Error(
      'getFakeGenerator() was called while the live client is selected. Set BRAMBLE_AI_MODE=fake or unset OPENAI_API_KEY.'
    );
  }
  return generator as FakeGenerator;
}

function withFixtures(generator: FakeGenerator): FakeGenerator {
  registerFixtures(generator);
  return generator;
}

/** Test seam: drops both memoised instances so env changes take effect. */
export function resetGenerators(): void {
  live = null;
  fake = null;
}
