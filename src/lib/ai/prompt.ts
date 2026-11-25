import { z } from 'zod';
import { StageName } from './models';

/**
 * A prompt and the shape of what it must produce.
 *
 * This is the only abstraction in the pipeline, and it is a data record rather
 * than control flow. Four generation stages do not justify a pipeline algebra:
 * they do not even share a shape — presenting a turn reads then writes, but
 * committing a decision *writes* first (the user's answer must be recorded
 * before the model runs), and summarising an arc may skip the model entirely. An
 * abstraction broad enough to cover all four degenerates into `async function`,
 * and forcing them into one unit of work is what would put a multi-second model
 * call inside a user's click.
 *
 * What the four genuinely share is this: a prompt, a schema, and one call. So
 * that is what gets a type.
 *
 * `render` is pure — no database, no clock, no environment — so prompt wording
 * is testable without a model, and persistence never sees anything but the
 * parsed `Out`. Swapping a prompt cannot reach the writers.
 */
export type PromptSpec<Vars, Out> = {
  /** Stable key. The fake selects a fixture by it; traces are tagged with it. */
  readonly name: string;
  /** Which stage's model and reasoning effort to use. */
  readonly stage: StageName;
  /** The entire contract between the prompt and everything downstream. */
  readonly schema: z.ZodType<Out>;
  readonly render: (vars: Vars) => RenderedPrompt;
};

export type RenderedPrompt = {
  system: string;
  prompt: string;
  /**
   * Offsets into `prompt` where a stretch the next request will repeat ends,
   * for the provider's prompt cache. Absent for a prompt that is not sent again
   * with the same start. See `prompts/cache.ts`.
   */
  cacheBreaks?: number[];
};

export type GenerationMeta = {
  promptName: string;
  model: string;
  inputTokens: number;
  /** Of `inputTokens`, how many the provider served from its prompt cache. */
  cachedInputTokens: number;
  /** Of `inputTokens`, how many were written to the prompt cache (billed at 1.25x). */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Of `outputTokens`, how many were the model thinking before it answered. */
  reasoningTokens: number;
  finishReason: string;
  durationMs: number;
};

export type GenerationResult<Out> = {
  value: Out;
  meta: GenerationMeta;
};

/**
 * One model call.
 *
 * Every cross-cutting concern in this pipeline — retry, timeout, token
 * accounting, tracing, error translation, and choosing the real client or the
 * fake — belongs to a single call rather than to a stage, so they all live
 * behind this one method. There is nothing that needs to happen once per
 * *stage*, which is the other half of why no stage abstraction exists.
 */
/**
 * How one call runs. `cacheKey` groups requests that share most of their
 * prompt (one session's beats), so the provider serves that prefix from its
 * cache: cheaper, and a little faster to start.
 */
export type RunOptions = { signal?: AbortSignal; cacheKey?: string };

/** What a structured output looks like while it is still being written. */
export type DeepPartial<T> = T extends (infer E)[]
  ? DeepPartial<E>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface Generator {
  run<Vars, Out>(
    spec: PromptSpec<Vars, Out>,
    vars: Vars,
    opts?: RunOptions
  ): Promise<GenerationResult<Out>>;

  /**
   * `run`, reporting the output as it is written: `onPartial` gets the object
   * so far, fields in the schema's order, the last of them possibly cut off
   * mid-word. Resolves with the same parsed, schema-checked result as `run`.
   */
  stream<Vars, Out>(
    spec: PromptSpec<Vars, Out>,
    vars: Vars,
    opts: RunOptions & { onPartial: (partial: DeepPartial<Out>) => void }
  ): Promise<GenerationResult<Out>>;
}
