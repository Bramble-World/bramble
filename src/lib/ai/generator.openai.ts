import { failureFields } from './failure';
import {
  LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  generateText,
  streamText,
  type LanguageModelUsage,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '@/env';
import {
  GenerationFailedError,
  GenerationTimeoutError,
  GenerationUnusableError,
  UpstreamBusyError,
} from '@/lib/utils/errors';
import { STAGE_MODELS } from './models';
import {
  DeepPartial,
  GenerationMeta,
  Generator,
  GenerationResult,
  PromptSpec,
  RenderedPrompt,
  RunOptions,
} from './prompt';
import { promptShape, type PromptShape } from './prompt-shape';
import { splitAt } from './prompts/cache';

/**
 * The only file in the repo that imports `ai` or `@ai-sdk/openai`.
 *
 * Everything above it speaks in `PromptSpec` and `GenerationResult`, so a
 * provider change, or the SDK's next reshuffle of this surface, stops here.
 * That is not hypothetical: `generateObject` is already deprecated in the
 * installed version in favour of `generateText` with an `output` setting, which
 * is the call used below.
 */
export function createOpenAIGenerator(apiKey: string): Generator {
  const openai = createOpenAI({ apiKey });
  return createGenerator((modelId) => openai(modelId));
}

/**
 * The call itself, with model resolution left to the caller.
 *
 * Split out so one test can substitute a `MockLanguageModelV3` and assert on the
 * request that was actually built — the rendered system and prompt, and the
 * reasoning effort. That is the one thing the domain-level fake cannot check,
 * because it never reaches the SDK. Everything above this layer is tested
 * against the fake instead, so only this file is coupled to the provider.
 */
export function createGenerator(resolveModel: (modelId: string) => LanguageModel): Generator {
  /** Everything a call sends, the same whether it streams or not. */
  function request<Vars, Out>(
    spec: PromptSpec<Vars, Out>,
    vars: Vars,
    opts?: RunOptions,
    tier: Tier = 'default',
    signal: AbortSignal | undefined = opts?.signal
  ) {
    const { model, reasoningEffort } = STAGE_MODELS[spec.stage];
    const rendered = spec.render(vars);
    const cut = Boolean(rendered.cacheBreaks?.length);
    return {
      model,
      reasoningEffort,
      tier,
      // Hashes and lengths of the request's parts, for the log line; see
      // prompt-shape.ts. Only for prompts cut for the cache, which are the ones
      // whose consecutive requests are worth comparing.
      shape: cut ? promptShape(rendered, opts?.cacheKey) : undefined,
      settings: {
        model: resolveModel(model),
        ...(cut ? cachedMessages(rendered) : { system: rendered.system, prompt: rendered.prompt }),
        // Reasoning models take effort rather than temperature; gpt-6 and
        // later drop sampling parameters entirely. See models.ts.
        providerOptions: {
          openai: {
            reasoningEffort,
            ...(tier === 'flex' ? { serviceTier: 'flex' as const } : {}),
            ...(opts?.cacheKey ? { promptCacheKey: opts.cacheKey } : {}),
            // Explicit: only the marked boundaries are written to the cache. In
            // the default (implicit) mode OpenAI also writes the whole request
            // at its end, at 1.25x the input price, and the end of a beat's
            // request is never sent again.
            ...(cut ? { promptCacheOptions: { mode: 'explicit' as const } } : {}),
          },
        },
        output: Output.object({ schema: spec.schema, name: schemaName(spec.name) }),
        abortSignal: signal,
      },
    };
  }

  function finished<Out>(
    spec: PromptSpec<unknown, Out>,
    model: string,
    reasoningEffort: string,
    tier: Tier,
    shape: PromptShape | undefined,
    startedAt: number,
    output: Out,
    usage: LanguageModelUsage,
    finishReason: string
  ): GenerationResult<Out> {
    const meta = {
      promptName: spec.name,
      model,
      inputTokens: usage.inputTokens ?? 0,
      cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
      finishReason,
      durationMs: Date.now() - startedAt,
    };
    logGeneration(spec.stage, reasoningEffort, tier, meta, shape);
    return { value: output, meta };
  }

  /**
   * The cause is attached, never interpolated. The message stays generic
   * because model output and provider bodies can echo the prompt, and the
   * prompt carries story content (invariants.md §1) — but discarding the cause
   * entirely makes a production failure impossible to diagnose, and `cause` is
   * what Sentry and `console.error` already follow.
   */
  function failed(
    spec: PromptSpec<unknown, unknown>,
    error: unknown,
    opts: RunOptions | undefined,
    startedAt: number,
    tier: Tier = 'default'
  ): Error {
    const translated = translate(error, spec.name);
    logFailure(spec.name, tier, translated, error, opts?.signal, Date.now() - startedAt);
    return translated;
  }

  async function attempt<Vars, Out>(
    spec: PromptSpec<Vars, Out>,
    vars: Vars,
    opts: RunOptions | undefined,
    tier: Tier,
    signal: AbortSignal | undefined
  ): Promise<GenerationResult<Out>> {
    const { model, reasoningEffort, shape, settings } = request(spec, vars, opts, tier, signal);
    const startedAt = Date.now();
    try {
      const result = await generateText(settings);
      return finished(
        spec as PromptSpec<unknown, Out>,
        model,
        reasoningEffort,
        tier,
        shape,
        startedAt,
        result.output as Out,
        result.usage,
        result.finishReason
      );
    } catch (error) {
      throw failed(spec as PromptSpec<unknown, unknown>, error, opts, startedAt, tier);
    }
  }

  return {
    async run<Vars, Out>(
      spec: PromptSpec<Vars, Out>,
      vars: Vars,
      opts?: RunOptions
    ): Promise<GenerationResult<Out>> {
      const flex = STAGE_MODELS[spec.stage].flex;
      if (!flex) return attempt(spec, vars, opts, 'default', opts?.signal);

      // Flex first, then the normal tier once if flex refused (429, its "resource
      // unavailable") or ran past its time. Our caller giving up is not a reason
      // to ask again, and nor is anything else going wrong: that would fail at
      // the normal tier too, at twice the price.
      const patience = AbortSignal.timeout(flex.withinMs);
      const signal = opts?.signal ? AbortSignal.any([opts.signal, patience]) : patience;
      try {
        return await attempt(spec, vars, opts, 'flex', signal);
      } catch (error) {
        if (opts?.signal?.aborted) throw error;
        const refused = error instanceof UpstreamBusyError;
        const tooSlow = patience.aborted && error instanceof GenerationTimeoutError;
        if (!refused && !tooSlow) throw error;
        return attempt(spec, vars, opts, 'default', opts?.signal);
      }
    },

    async stream<Vars, Out>(
      spec: PromptSpec<Vars, Out>,
      vars: Vars,
      opts: RunOptions & { onPartial: (partial: DeepPartial<Out>) => void }
    ): Promise<GenerationResult<Out>> {
      const { model, reasoningEffort, shape, settings } = request(spec, vars, opts);
      const startedAt = Date.now();
      try {
        // A streamed call reports its failure here rather than throwing, and
        // the default handler would print it, prompt echo and all.
        let failure: unknown;
        const result = streamText({
          ...settings,
          onError: ({ error }) => {
            failure ??= error;
          },
        });
        for await (const partial of result.partialOutputStream) {
          opts.onPartial(partial as DeepPartial<Out>);
        }
        if (failure !== undefined) throw failure;
        const [output, usage, finishReason] = await Promise.all([
          result.output,
          result.usage,
          result.finishReason,
        ]);
        return finished(
          spec as PromptSpec<unknown, Out>,
          model,
          reasoningEffort,
          'default',
          shape,
          startedAt,
          output as Out,
          usage,
          finishReason
        );
      } catch (error) {
        throw failed(spec as PromptSpec<unknown, unknown>, error, opts, startedAt);
      }
    },
  };
}

/** Which OpenAI service tier a call was asked at; see `StageModel.flex`. */
type Tier = 'default' | 'flex';

/** Marks the end of a content block as a place the prompt cache may stop. */
const BREAKPOINT = { openai: { promptCacheBreakpoint: { mode: 'explicit' } } };

/**
 * The request as messages, so that the cache has somewhere to stop inside it.
 *
 * On GPT-5.6 and later a cached prefix can end only at a boundary: a message's
 * end or a block marked as a breakpoint (prompts/cache.ts). The system message
 * gets one, and the prompt is sent as one block per stretch between its
 * `cacheBreaks`, each but the last marked. The blocks join back into exactly
 * the prompt, so the model reads the same text.
 */
function cachedMessages({ system, prompt, cacheBreaks = [] }: RenderedPrompt) {
  const parts = splitAt(prompt, cacheBreaks);
  return {
    system: { role: 'system' as const, content: system, providerOptions: BREAKPOINT },
    prompt: [
      {
        role: 'user' as const,
        content: parts.map((text, index) => ({
          type: 'text' as const,
          text,
          ...(index < parts.length - 1 ? { providerOptions: BREAKPOINT } : {}),
        })),
      },
    ],
  };
}

/**
 * Turns provider failures into the error types the rest of the app already
 * handles, so a route or an action never has to know an SDK was involved.
 *
 * The model's own text is deliberately not copied into the message: it can echo
 * the prompt, and the prompt carries story content. invariants.md §1 keeps raw
 * material out of the database, and there is no reason to let it leak into a log
 * instead.
 */
function translate(error: unknown, promptName: string): Error {
  // Both, and they are not interchangeable: output that will not parse against
  // the schema raises NoObjectGeneratedError, while NoOutputGeneratedError comes
  // from a step that produced nothing to parse at all. Checking only the latter
  // — which reads like the obvious one — misses the common case entirely.
  if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
    // The model answered, but not with something matching the schema. Worth
    // distinguishing, because it means the prompt or the schema needs work
    // rather than the request being retried.
    return withCause(
      new GenerationUnusableError(`The model returned no usable output for "${promptName}"`),
      error
    );
  }

  const status =
    (error as { statusCode?: number; status?: number })?.statusCode ??
    (error as { status?: number })?.status;

  // The provider throttling us is not the same as our own quota, and the two
  // need opposite client behaviour — this one clears on its own.
  if (status === 429) {
    return withCause(new UpstreamBusyError(60), error);
  }

  // Our deadline, not theirs. The SDK surfaces an aborted request as an
  // AbortError; without this it would read as an ordinary provider failure and
  // the client would back off when it should simply re-call.
  if (isAbort(error)) {
    return withCause(new GenerationTimeoutError(), error);
  }

  return withCause(new GenerationFailedError(`Generation failed for "${promptName}"`), error);
}

/**
 * One line per model call: which stage, how long, and how many tokens, so the
 * wait and the cost can be read per stage. Numbers and names only, never the
 * prompt or the output, which carry story content.
 */
function logGeneration(
  stage: string,
  effort: string,
  tier: Tier,
  meta: GenerationMeta,
  shape: PromptShape | undefined
): void {
  console.info(
    JSON.stringify({
      event: 'generation',
      prompt: meta.promptName,
      stage,
      model: meta.model,
      effort,
      tier,
      durationMs: meta.durationMs,
      inputTokens: meta.inputTokens,
      cachedInputTokens: meta.cachedInputTokens,
      cacheWriteTokens: meta.cacheWriteTokens,
      outputTokens: meta.outputTokens,
      reasoningTokens: meta.reasoningTokens,
      finishReason: meta.finishReason,
      ...(shape ? { shape } : {}),
    })
  );
}

function logFailure(
  promptName: string,
  tier: Tier,
  translated: Error,
  error: unknown,
  signal: AbortSignal | undefined,
  durationMs: number
): void {
  console.warn(
    JSON.stringify({
      event: 'generation_failed',
      prompt: promptName,
      tier,
      // The error's code, not its class name: the server bundle drops class
      // names, so `name` logged as "".
      as: (translated as { code?: string }).code ?? translated.name,
      ...failureFields(error),
      callerGaveUp: signal?.aborted ?? false,
      durationMs,
    })
  );
}

/**
 * Whether this failure is our own abort.
 *
 * Checked by name and by the standard DOMException code rather than by class:
 * the abort can surface from undici, from the SDK's own wrapper, or from the
 * signal itself, and they are not the same constructor.
 */
function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; code?: unknown; cause?: unknown };
  // `ResponseAborted` is Next's, for a client that has disconnected.
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'ResponseAborted')
    return true;
  if (e.code === 20 || e.code === 'ABORT_ERR') return true;
  return e.cause ? isAbort(e.cause) : false;
}

/** Keeps the original error reachable for logs without putting it in the message. */
function withCause<E extends Error>(error: E, cause: unknown): E {
  error.cause = cause;
  return error;
}

/**
 * Sanitises a prompt name for the provider's schema-name field.
 *
 * OpenAI requires `^[a-zA-Z0-9_-]+$` and rejects the request outright otherwise,
 * so a dotted name like `turn.generate` — which is the convention used for
 * prompt keys everywhere else — fails every live call while passing every test
 * against a mock, because no mock enforces the provider's naming rules.
 *
 * Sanitising here rather than renaming the prompts keeps the constraint where it
 * belongs: `PromptSpec.name` is ours, used for fixtures and tracing, and should
 * not be shaped by one provider's validation.
 */
export function schemaName(promptName: string): string {
  return promptName.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/** Whether a live client can be built at all. */
export function hasOpenAIKey(): boolean {
  return Boolean(env.OPENAI_API_KEY);
}
