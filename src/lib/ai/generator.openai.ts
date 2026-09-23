import {
  LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  generateText,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '@/env';
import { InternalServerError, RateLimitError } from '@/lib/utils/errors';
import { STAGE_MODELS } from './models';
import { Generator, GenerationResult, PromptSpec } from './prompt';

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
  return {
    async run<Vars, Out>(
      spec: PromptSpec<Vars, Out>,
      vars: Vars,
      opts?: { signal?: AbortSignal }
    ): Promise<GenerationResult<Out>> {
      const { model, reasoningEffort } = STAGE_MODELS[spec.stage];
      const { system, prompt } = spec.render(vars);
      const startedAt = Date.now();

      try {
        const result = await generateText({
          model: resolveModel(model),
          system,
          prompt,
          // Reasoning models take effort rather than temperature; gpt-6 and
          // later drop sampling parameters entirely. See models.ts.
          providerOptions: { openai: { reasoningEffort } },
          output: Output.object({
            schema: spec.schema,
            name: schemaName(spec.name),
          }),
          abortSignal: opts?.signal,
        });

        return {
          value: result.output,
          meta: {
            promptName: spec.name,
            model,
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            finishReason: result.finishReason,
            durationMs: Date.now() - startedAt,
          },
        };
      } catch (error) {
        // The cause is attached, never interpolated. The message stays generic
        // because model output and provider bodies can echo the prompt, and the
        // prompt carries story content (invariants.md §1) — but discarding the
        // cause entirely makes a production failure impossible to diagnose, and
        // `cause` is what Sentry and `console.error` already follow.
        throw translate(error, spec.name);
      }
    },
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
      new InternalServerError(`The model returned no usable output for "${promptName}"`),
      error
    );
  }

  const status =
    (error as { statusCode?: number; status?: number })?.statusCode ??
    (error as { status?: number })?.status;

  if (status === 429) {
    return withCause(new RateLimitError(60), error);
  }

  return withCause(new InternalServerError(`Generation failed for "${promptName}"`), error);
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
