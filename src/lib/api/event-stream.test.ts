import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { eventStream, wantsEventStream } = await import('./event-stream');
const { RateLimitError, NotFoundError } = await import('@/lib/utils/errors');

/** The events in a streamed body, in order. */
async function events(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')),
      };
    });
}

describe('wantsEventStream', () => {
  it('is only for a client that asks', () => {
    const asks = new Request('http://x', { headers: { accept: 'text/event-stream' } });
    expect(wantsEventStream(asks)).toBe(true);
    expect(wantsEventStream(new Request('http://x'))).toBe(false);
  });
});

describe('eventStream', () => {
  it('sends what the work sends, then done with the finished body', async () => {
    const response = await eventStream(
      async ({ send }) => {
        send('draft', { n: 1 });
        send('draft', { n: 2 });
        return 'beat';
      },
      async (result) => ({ turn: result })
    );

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(await events(response)).toStrictEqual([
      { event: 'draft', data: { n: 1 } },
      { event: 'draft', data: { n: 2 } },
      { event: 'done', data: { turn: 'beat' } },
    ]);
  });

  it('sends done alone when there was nothing to stream (a beat already written)', async () => {
    const response = await eventStream(
      async () => 'beat',
      async (result) => ({ turn: result })
    );
    expect(await events(response)).toStrictEqual([{ event: 'done', data: { turn: 'beat' } }]);
  });

  /** Out of battery, not your session: answered with its real status, as without streaming. */
  it('throws a failure from before the first event, for the caller to answer', async () => {
    await expect(
      eventStream(
        async () => {
          throw new NotFoundError('Session', 's');
        },
        async () => ({})
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('turns a failure after the first event into an error event with its status', async () => {
    const response = await eventStream(
      async ({ send }) => {
        send('draft', { n: 1 });
        throw new RateLimitError(60);
      },
      async () => ({})
    );

    const sent = await events(response);
    expect(sent.at(-1)?.event).toBe('error');
    expect(sent.at(-1)?.data).toMatchObject({ status: 429, error: { code: 'RATE_LIMITED' } });
  });
});
