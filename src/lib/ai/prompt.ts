import { z } from 'zod';
import { ReasoningEffort, StageName } from './models';

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
  readonly render: (vars: Vars) => { system: string; prompt: string };
};

/**
 * What one model call cost.
 *
 * **The breakdown is the point, not the totals.** `inputTokens` and
 * `outputTokens` alone cannot answer either question that matters about spend:
 *
 * - **How much of the output was thinking?** Reasoning tokens bill as output and
 *   are the majority of it, so output cost is governed by `reasoningEffort` in
 *   models.ts rather than by how long a beat is. Without `reasoningTokens` that
 *   is a guess.
 * - **Is prompt caching working?** A cache *write* costs roughly nineteen times
 *   a cache *read* of the same token, so a prompt whose prefix shifts between
 *   calls is billed at the write rate forever and the saving never arrives.
 *   `cacheReadTokens` against `cacheWriteTokens` is the only way to see it, and
 *   it is invisible in the totals because both land in `inputTokens`.
 *
 * Every field is a count, an id or an enum — never prompt or model text — so the
 * whole record is safe to log (invariants.md §1).
 */
export type GenerationMeta = {
  promptName: string;
  /** Which stage, so cost can be attributed without parsing `promptName`. */
  stage: StageName;
  model: string;
  reasoningEffort: ReasoningEffort;
  inputTokens: number;
  /** Billed at the cheap rate. High is good. */
  cacheReadTokens: number;
  /** Billed at a large premium. High means the prefix is not stable. */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Part of `outputTokens`, not additional to it. */
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
export interface Generator {
  run<Vars, Out>(
    spec: PromptSpec<Vars, Out>,
    vars: Vars,
    opts?: { signal?: AbortSignal }
  ): Promise<GenerationResult<Out>>;
}
