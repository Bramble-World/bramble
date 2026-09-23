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
  readonly render: (vars: Vars) => { system: string; prompt: string };
};

export type GenerationMeta = {
  promptName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
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
