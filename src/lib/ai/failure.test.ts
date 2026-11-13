import { describe, expect, it } from 'vitest';
import { failureFields } from './failure';

describe('failureFields', () => {
  it("reads the provider's status, type and code through the SDK's wrappers, and never a message", () => {
    const provider = Object.assign(new Error('the story says: jordan was there'), {
      name: 'AI_APICallError',
      statusCode: 500,
      data: { error: { type: 'server_error', code: 'internal', message: 'jordan was there' } },
    });
    const retried = Object.assign(new Error('Failed after 3 attempts: jordan'), {
      name: 'AI_RetryError',
      lastError: provider,
    });

    const fields = failureFields(retried);

    expect(fields).toEqual({
      name: 'AI_RetryError',
      status: 500,
      type: 'server_error',
      code: 'internal',
    });
    expect(JSON.stringify(fields)).not.toContain('jordan');
  });

  it('copes with errors that say nothing, and with cycles', () => {
    expect(failureFields(undefined)).toEqual({});
    const loop: { cause?: unknown; name: string } = { name: 'Loop' };
    loop.cause = loop;
    expect(failureFields(loop)).toEqual({ name: 'Loop' });
  });
});
