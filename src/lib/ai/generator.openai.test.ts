import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import {
  GenerationFailedError,
  GenerationTimeoutError,
  GenerationUnusableError,
  UpstreamBusyError,
} from '@/lib/utils/errors';
import { createOpenAI } from '@ai-sdk/openai';
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

function modelReturning(
  text: string,
  usage: object = { inputTokens: { total: 11 }, outputTokens: { total: 7 } }
) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      // Both of these are objects at the provider boundary in this SDK version,
      // and both fail *silently* if given the flat shape they had previously —
      // undefined counts and an undefined reason rather than a type error. Worth
      // pinning, since this file exists to catch exactly that kind of drift.
      finishReason: { unified: 'stop' as const },
      usage: usage as never,
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

  it('passes a cache key through as the prompt cache key, and none when absent', async () => {
    const keyed = modelReturning('{"narrative":"She waited."}');
    await createGenerator(() => keyed).run(spec, { title: 'Unsent' }, { cacheKey: 'turn:abc' });
    expect(keyed.doGenerateCalls[0].providerOptions?.openai).toMatchObject({
      promptCacheKey: 'turn:abc',
    });

    const plain = modelReturning('{"narrative":"She waited."}');
    await createGenerator(() => plain).run(spec, { title: 'Unsent' });
    expect(plain.doGenerateCalls[0].providerOptions?.openai).not.toHaveProperty('promptCacheKey');
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

  it('reads cached and reasoning tokens, and logs one line of numbers per call', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const generator = createGenerator(() =>
      modelReturning('{"narrative":"She waited."}', {
        inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
        outputTokens: { total: 300, text: 120, reasoning: 180 },
      })
    );

    const { meta } = await generator.run(spec, { title: 'Unsent' });

    expect(meta.cachedInputTokens).toBe(1000);
    expect(meta.reasoningTokens).toBe(180);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'generation',
      prompt: 'test.turn',
      stage: 'turn',
      inputTokens: 1200,
      cachedInputTokens: 1000,
      outputTokens: 300,
      reasoningTokens: 180,
    });
    // Never the story: not the prompt, not the output.
    for (const marker of ['SYSTEM MARKER', 'PROMPT MARKER', 'Unsent', 'She waited']) {
      expect(line).not.toContain(marker);
    }
    log.mockRestore();
  });

  /**
   * Output that does not match the schema is a prompt or schema problem, not a
   * transient one, so it must not surface as something a caller would retry.
   *
   * Distinct from a provider failure on purpose: both used to be one generic
   * error, and a client cannot choose a retry policy from that. This one is
   * usually deterministic, so retrying it buys the same failure twice.
   */
  it('translates unusable output into GENERATION_UNUSABLE', async () => {
    const generator = createGenerator(() => modelReturning('not json at all'));

    const error = await generator.run(spec, { title: 'Unsent' }).catch((e) => e);

    expect(error).toBeInstanceOf(GenerationUnusableError);
    expect(error.code).toBe('GENERATION_UNUSABLE');
    expect(error.statusCode).toBe(500);
  });

  // A provider blip, by contrast, usually clears — so it is a different class
  // with a different status and a retry policy to match.
  it('translates a provider failure into GENERATION_FAILED', async () => {
    const generator = createGenerator(
      () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw Object.assign(new Error('upstream exploded'), { statusCode: 500 });
          },
        })
    );

    const error = await generator.run(spec, { title: 'Unsent' }).catch((e) => e);

    expect(error).toBeInstanceOf(GenerationFailedError);
    expect(error.statusCode).toBe(503);
  });

  /**
   * Our own deadline, not the provider's.
   *
   * `Generator.run` has always accepted a signal and nothing ever passed one.
   * Now that callers do, an abort must not read as an ordinary provider failure:
   * the client should re-call immediately rather than back off.
   */
  it('translates our own abort into GENERATION_TIMEOUT', async () => {
    const generator = createGenerator(
      () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          },
        })
    );

    const error = await generator.run(spec, { title: 'Unsent' }).catch((e) => e);

    expect(error).toBeInstanceOf(GenerationTimeoutError);
    expect(error.statusCode).toBe(504);
  });

  /**
   * The provider throttling us is not our own quota.
   *
   * Kept apart because they need opposite client behaviour, and while they
   * shared the RATE_LIMITED code they were indistinguishable on the wire.
   */
  it('translates a provider 429 into UPSTREAM_BUSY, not our own rate limit', async () => {
    const generator = createGenerator(
      () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw Object.assign(new Error('slow down'), { statusCode: 429 });
          },
        })
    );

    const error = await generator.run(spec, { title: 'Unsent' }).catch((e) => e);

    expect(error).toBeInstanceOf(UpstreamBusyError);
    expect(error.code).toBe('UPSTREAM_BUSY');
    expect(error.retryAfter).toBe(60);
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

describe('streaming from the OpenAI generator', () => {
  /** What the provider sends, as pieces of the JSON text. */
  function modelStreaming(pieces: string[]) {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          ...pieces.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end' as const, id: '1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 7, text: 7, reasoning: 0 },
            },
          },
        ]) as never,
      }),
    });
  }

  it('reports the object as it is written, and returns it parsed', async () => {
    const generator = createGenerator(() =>
      modelStreaming(['{"narr', 'ative":"She ', 'waited."}'])
    );
    const partials: unknown[] = [];

    const result = await generator.stream(
      spec,
      { title: 'Unsent' },
      {
        onPartial: (p) => partials.push(p),
      }
    );

    expect(result.value).toStrictEqual({ narrative: 'She waited.' });
    expect(result.meta.inputTokens).toBe(11);
    expect(partials.at(-1)).toStrictEqual({ narrative: 'She waited.' });
    expect(partials.length).toBeGreaterThan(1);
  });

  it('translates output that does not match the schema into GENERATION_UNUSABLE', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generator = createGenerator(() => modelStreaming(['{"other":1}']));

    await expect(
      generator.stream(spec, { title: 'Unsent' }, { onPartial: () => {} })
    ).rejects.toMatchObject({ code: 'GENERATION_UNUSABLE' });
  });
});

/**
 * What reaches OpenAI for a prompt cut for its cache, through the real provider
 * rather than a mock, because the cut lives in how the provider serialises the
 * request: on GPT-5.6 and later a cached prefix can only end at a marked block.
 */
describe('the prompt cache, on the wire', () => {
  const cutSpec: PromptSpec<Vars, Out> = {
    ...spec,
    render: () => ({
      system: 'SYSTEM MARKER',
      prompt: 'STABLE ONE\nSTABLE TWO\nCHANGES',
      cacheBreaks: [11, 22],
    }),
  };

  async function send(chosen: PromptSpec<Vars, Out>) {
    const bodies: Record<string, unknown>[] = [];
    const openai = createOpenAI({
      apiKey: 'test',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            created_at: 0,
            model: STAGE_MODELS.turn.model,
            output: [
              {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: '{"narrative":"She waited."}', annotations: [] },
                ],
              },
            ],
            usage: {
              input_tokens: 5000,
              input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 600 },
              output_tokens: 10,
              output_tokens_details: { reasoning_tokens: 0 },
            },
            incomplete_details: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { meta } = await createGenerator((id) => openai(id)).run(
      chosen,
      { title: 'Unsent' },
      { cacheKey: 'turn:sess-1' }
    );
    const line = String(log.mock.calls[0][0]);
    log.mockRestore();
    return { body: bodies[0], meta, line };
  }

  it('marks the system message and each stable stretch, and caches nothing else', async () => {
    const { body } = await send(cutSpec);

    expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(body.prompt_cache_key).toBe('turn:sess-1');
    const breakpoint = { mode: 'explicit' };
    expect(body.input).toEqual([
      {
        role: 'developer',
        content: [
          { type: 'input_text', text: 'SYSTEM MARKER', prompt_cache_breakpoint: breakpoint },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'STABLE ONE\n', prompt_cache_breakpoint: breakpoint },
          { type: 'input_text', text: 'STABLE TWO\n', prompt_cache_breakpoint: breakpoint },
          { type: 'input_text', text: 'CHANGES' },
        ],
      },
    ]);
  });

  it('sends a prompt without breaks as before', async () => {
    const { body } = await send(spec);

    expect(body).not.toHaveProperty('prompt_cache_options');
    expect(body.input).toEqual([
      { role: 'developer', content: 'SYSTEM MARKER' },
      { role: 'user', content: [{ type: 'input_text', text: 'PROMPT MARKER Unsent' }] },
    ]);
  });

  it('logs cache writes and the request as fingerprints, never its text', async () => {
    const { meta, line } = await send(cutSpec);

    expect(meta.cachedInputTokens).toBe(4000);
    expect(meta.cacheWriteTokens).toBe(600);
    const logged = JSON.parse(line);
    expect(logged).toMatchObject({ cachedInputTokens: 4000, cacheWriteTokens: 600 });
    expect(logged.shape.key).toMatch(/^[0-9a-f]{8}$/);
    expect(logged.shape.system).toMatch(/^[0-9a-f]{8}:13$/);
    expect(logged.shape.blocks).toHaveLength(3);
    expect(logged.shape.blocks[2]).toMatch(/^[0-9a-f]{8}:7$/);
    expect(logged.shape.sections).toEqual([expect.stringMatching(/^head:[0-9a-f]{8}:29$/)]);
    for (const marker of ['SYSTEM MARKER', 'STABLE', 'CHANGES', 'sess-1', 'She waited']) {
      expect(line).not.toContain(marker);
    }
  });

  describe('the flex tier', () => {
    const background: PromptSpec<Vars, Out> = {
      ...spec,
      name: 'test.consequence',
      stage: 'consequence',
    };

    function modelAnswering(...answers: Array<'ok' | 'busy' | 'broken' | 'slow'>) {
      let call = 0;
      return new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          const answer = answers[call++];
          if (answer === 'busy')
            throw Object.assign(new Error('Resource unavailable'), { statusCode: 429 });
          if (answer === 'broken')
            throw Object.assign(new Error('Bad request'), { statusCode: 400 });
          if (answer === 'slow') {
            await new Promise((_, reject) => {
              if (abortSignal?.aborted) reject(abortSignal.reason);
              abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
            });
          }
          return {
            content: [{ type: 'text' as const, text: '{"narrative":"x"}' }],
            finishReason: { unified: 'stop' as const },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as never,
            warnings: [],
          };
        },
      });
    }

    const tiers = (model: MockLanguageModelV3) =>
      model.doGenerateCalls.map(
        (c) => (c.providerOptions?.openai as { serviceTier?: string })?.serviceTier ?? 'default'
      );

    it('asks a background stage at flex, and a beat at the normal tier', async () => {
      const flex = modelAnswering('ok');
      await createGenerator(() => flex).run(background, { title: 'x' });
      expect(tiers(flex)).toEqual(['flex']);

      const beat = modelAnswering('ok');
      await createGenerator(() => beat).run(spec, { title: 'x' });
      expect(tiers(beat)).toEqual(['default']);
    });

    it('asks once more at the normal tier when flex refuses', async () => {
      const model = modelAnswering('busy', 'ok');
      const result = await createGenerator(() => model).run(background, { title: 'x' });
      expect(result.value).toEqual({ narrative: 'x' });
      expect(tiers(model)).toEqual(['flex', 'default']);
    });

    it('asks at the normal tier when flex is too slow', async () => {
      // AbortSignal.timeout runs on the real clock, so the stage's patience is
      // shortened for the test rather than the clock faked.
      const flex = STAGE_MODELS.consequence.flex!;
      const withinMs = flex.withinMs;
      flex.withinMs = 20;
      try {
        const model = modelAnswering('slow', 'ok');
        const result = await createGenerator(() => model).run(background, { title: 'x' });
        expect(result.value).toEqual({ narrative: 'x' });
        expect(tiers(model)).toEqual(['flex', 'default']);
      } finally {
        flex.withinMs = withinMs;
      }
    });

    it('does not ask again for a failure the normal tier would share', async () => {
      const model = modelAnswering('broken', 'ok');
      await expect(
        createGenerator(() => model).run(background, { title: 'x' })
      ).rejects.toBeInstanceOf(GenerationFailedError);
      expect(tiers(model)).toEqual(['flex']);
    });

    it('does not ask again once the caller has given up', async () => {
      const controller = new AbortController();
      const model = modelAnswering('slow', 'ok');
      const run = createGenerator(() => model).run(
        background,
        { title: 'x' },
        { signal: controller.signal }
      );
      controller.abort();
      await expect(run).rejects.toBeInstanceOf(GenerationTimeoutError);
      expect(tiers(model)).toEqual(['flex']);
    });
  });
});
