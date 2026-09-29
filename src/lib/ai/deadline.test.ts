import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { GenerationTimeoutError } from '@/lib/utils/errors';
import { createGenerator } from './generator.openai';
import { withDeadline } from './deadline';
import type { PromptSpec } from './prompt';

const spec: PromptSpec<{ x: string }, { ok: boolean }> = {
  name: 'deadline.probe',
  stage: 'turn',
  schema: z.object({ ok: z.boolean() }),
  render: () => ({ system: 's', prompt: 'p' }),
};

/**
 * A model that never answers unless its signal fires.
 *
 * Checks `aborted` before subscribing: a signal that fired before the model was
 * reached would otherwise never deliver the event, and the promise would hang
 * for the full test timeout. Real clients have the same race.
 */
const hangingModel = () =>
  new MockLanguageModelV3({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (abortSignal?.aborted) return fail();
        abortSignal?.addEventListener('abort', fail);
      }),
  });

describe('withDeadline', () => {
  it('returns the value when the work finishes in time', async () => {
    await expect(withDeadline(async () => 'done', 1_000)).resolves.toBe('done');
  });

  /**
   * The point of the whole file.
   *
   * `Generator.run` has always accepted a signal and nothing ever passed one, so
   * every generation was bounded only by undici's 300s headers timeout — which
   * fails with no status code and three automatic retries, billing one user
   * action as three model calls. This proves the signal now reaches the model
   * and that the abort surfaces as something a caller can act on.
   */
  it('aborts a hanging generation and reports it as a timeout', async () => {
    const generator = createGenerator(hangingModel);

    const error = await withDeadline(
      (signal) => generator.run(spec, { x: 'y' }, { signal }),
      20
    ).catch((e) => e);

    expect(error).toBeInstanceOf(GenerationTimeoutError);
    expect(error.statusCode).toBe(504);
  });

  // A dangling timer keeps a process alive: an idle serverless invocation you
  // pay for, or a slow leak under load on a long-lived server.
  it('clears its timer on both paths', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');

    clear.mockClear();
    await withDeadline(async () => 'ok', 1_000);
    expect(clear).toHaveBeenCalled();

    clear.mockClear();
    await withDeadline(async () => {
      throw new Error('boom');
    }, 1_000).catch(() => undefined);
    expect(clear).toHaveBeenCalled();

    clear.mockRestore();
  });

  // A client that hangs up should cancel the work rather than leave it running
  // for a response nobody will read.
  it('also aborts when an external signal fires first', async () => {
    const caller = new AbortController();
    const generator = createGenerator(hangingModel);

    const pending = withDeadline(
      (signal) => generator.run(spec, { x: 'y' }, { signal }),
      60_000,
      caller.signal
    ).catch((e) => e);

    caller.abort();

    expect(await pending).toBeInstanceOf(GenerationTimeoutError);
  });
});
