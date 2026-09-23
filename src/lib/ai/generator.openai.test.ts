import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { InternalServerError, RateLimitError } from '@/lib/utils/errors';
import { createGenerator, schemaName } from './generator.openai';
import { STAGE_MODELS } from './models';
import { PromptSpec } from './prompt';

/**
 * The only test in the repo coupled to the AI SDK.
 *
 * Everything above this layer is tested against the domain-level fake, which
 * cannot see the request that was actually built. This one can: it substitutes a
 * mock model and reads `doGenerateCalls` verbatim, so it is the only thing that
 * can prove the rendered prompt reached the provider and that the stage's
 * reasoning effort was applied.
 *
 * It is deliberately small, because it is also the only thing that has to be
 * rewritten when the SDK reshuffles this surface — which it does: the installed
 * version already deprecates `generateObject` in favour of the call under test.
 */
type Vars = { title: string };
type Out = { narrative: string };

const spec: PromptSpec<Vars, Out> = {
  name: 'test.turn',
  stage: 'turn',
  schema: z.object({ narrative: z.string() }),
  render: (vars) => ({
    system: 'SYSTEM MARKER',
    prompt: `PROMPT MARKER ${vars.title}`,
  }),
};

function modelReturning(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      // Both of these are objects at the provider boundary in this SDK version,
      // and both fail *silently* if given the flat shape they had previously —
      // undefined counts and an undefined reason rather than a type error. Worth
      // pinning, since this file exists to catch exactly that kind of drift.
      finishReason: { unified: 'stop' as const },
      usage: { inputTokens: { total: 11 }, outputTokens: { total: 7 } },
      warnings: [],
    }),
  });
}

describe('the OpenAI generator', () => {
  it('sends the rendered system and prompt to the model', async () => {
    const model = modelReturning('{"narrative":"She waited."}');
    const generator = createGenerator(() => model);

    await generator.run(spec, { title: 'Unsent' });

    const call = model.doGenerateCalls[0];
    const serialised = JSON.stringify(call.prompt);
    expect(serialised).toContain('SYSTEM MARKER');
    expect(serialised).toContain('PROMPT MARKER Unsent');
  });

  // Reasoning models take effort rather than temperature, and gpt-6 drops
  // sampling parameters entirely — so if this stopped being sent, the only
  // symptom would be a quietly different cost and latency profile.
  it("applies the stage's reasoning effort", async () => {
    const model = modelReturning('{"narrative":"x"}');
    const generator = createGenerator(() => model);

    await generator.run(spec, { title: 'Unsent' });

    expect(model.doGenerateCalls[0].providerOptions?.openai).toMatchObject({
      reasoningEffort: STAGE_MODELS.turn.reasoningEffort,
    });
  });

  // Found by a live call, not by a mock: OpenAI validates the schema name
  // against ^[a-zA-Z0-9_-]+$ and rejects the whole request otherwise. Prompt
  // keys are dotted by convention, so without this every live call fails while
  // every mocked test passes.
  describe('schemaName', () => {
    it('strips characters the provider rejects', () => {
      expect(schemaName('turn.generate')).toBe('turn_generate');
      expect(schemaName('consequence.commit.v2')).toBe('consequence_commit_v2');
    });

    it('leaves already-valid names alone', () => {
      expect(schemaName('turn_generate-v2')).toBe('turn_generate-v2');
    });

    it.each(['turn.generate', 'a b', 'x/y', 'é'])('always yields a valid name for %s', (input) => {
      expect(schemaName(input)).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });

  it('resolves the model id the stage names', async () => {
    let requested = '';
    const generator = createGenerator((modelId) => {
      requested = modelId;
      return modelReturning('{"narrative":"x"}');
    });

    await generator.run(spec, { title: 'Unsent' });

    expect(requested).toBe(STAGE_MODELS.turn.model);
  });

  it('returns the parsed object and the usage alongside it', async () => {
    const generator = createGenerator(() => modelReturning('{"narrative":"She waited."}'));

    const result = await generator.run(spec, { title: 'Unsent' });

    expect(result.value).toStrictEqual({ narrative: 'She waited.' });
    expect(result.meta.inputTokens).toBe(11);
    expect(result.meta.outputTokens).toBe(7);
    expect(result.meta.finishReason).toBe('stop');
  });

  // Output that does not match the schema is a prompt or schema problem, not a
  // transient one, so it must not surface as something a caller would retry.
  it('translates unusable output into an internal error', async () => {
    const generator = createGenerator(() => modelReturning('not json at all'));

    await expect(generator.run(spec, { title: 'Unsent' })).rejects.toBeInstanceOf(
      InternalServerError
    );
  });

  it('translates a rate limit into a RateLimitError', async () => {
    const generator = createGenerator(
      () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw Object.assign(new Error('slow down'), { statusCode: 429 });
          },
        })
    );

    await expect(generator.run(spec, { title: 'Unsent' })).rejects.toBeInstanceOf(RateLimitError);
  });

  // The model's own text can echo the prompt, and the prompt carries story
  // content. invariants.md §1 keeps that out of the database; there is no reason
  // to let it into an error message instead.
  it('does not copy model output or prompt content into the error', async () => {
    const generator = createGenerator(() =>
      modelReturning('SECRET STORY CONTENT that is not valid json')
    );

    await expect(generator.run(spec, { title: 'Unsent' })).rejects.toThrow(
      /^The model returned no usable output for "test\.turn"$/
    );
  });
});
