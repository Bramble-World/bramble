import { describe, expect, it, vi } from 'vitest';
import { routeOf, withRequestLog, type RequestLogLine } from './request-log';

const SESSION = '1f2e3d4c-5b6a-4789-8abc-def012345678';

function capture() {
  const lines: RequestLogLine[] = [];
  return { lines, log: (line: RequestLogLine) => lines.push(line) };
}

describe('routeOf', () => {
  it('replaces ids and numbers, and drops the query string', () => {
    expect(routeOf(`https://api.test/api/v1/sessions/${SESSION}/turn?x=secret`)).toBe(
      '/api/v1/sessions/:id/turn'
    );
    expect(routeOf('https://api.test/api/v1/onboarding/answers/2')).toBe(
      '/api/v1/onboarding/answers/:n'
    );
  });
});

describe('withRequestLog', () => {
  it('logs one line with the route, status, duration and client, and returns the request id', async () => {
    const { lines, log } = capture();
    const handler = withRequestLog(
      async () => Response.json({ turn: { narrative: 'secret story' } }),
      log
    );

    const response = await handler(
      new Request(`https://api.test/api/v1/sessions/${SESSION}/turn`, {
        method: 'POST',
        headers: { 'x-bramble-client': 'ios/1.2 (16)', authorization: 'Bearer secret-token' },
        body: JSON.stringify({ choice: 'secret answer' }),
      })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'request',
      method: 'POST',
      route: '/api/v1/sessions/:id/turn',
      status: 200,
      client: 'ios/1.2 (16)',
    });
    expect(lines[0].ms).toBeGreaterThanOrEqual(0);
    expect(response.headers.get('X-Request-Id')).toBe(lines[0].requestId);
    // What it never carries: bodies, tokens, story text, the raw id.
    const written = JSON.stringify(lines);
    for (const secret of ['secret', SESSION, 'Bearer']) expect(written).not.toContain(secret);
    await expect(response.json()).resolves.toEqual({ turn: { narrative: 'secret story' } });
  });

  it('adds the error code, and only the code, for an error response', async () => {
    const { lines, log } = capture();
    const handler = withRequestLog(
      async () =>
        Response.json(
          { error: { code: 'RATE_LIMITED', message: 'about your secret story', retryAfter: 30 } },
          { status: 429 }
        ),
      log
    );

    const response = await handler(new Request('https://api.test/api/v1/world'));

    expect(lines[0]).toMatchObject({ status: 429, code: 'RATE_LIMITED', route: '/api/v1/world' });
    expect(JSON.stringify(lines)).not.toContain('secret');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('logs a thrown error as a 500 and throws it on', async () => {
    const { lines, log } = capture();
    const handler = withRequestLog(async () => {
      throw new Error('secret');
    }, log);

    await expect(handler(new Request('https://api.test/api/me'))).rejects.toThrow('secret');
    expect(lines[0]).toMatchObject({ status: 500, code: 'UNHANDLED', route: '/api/me' });
  });

  it('ignores a request id that is not a plain token', async () => {
    const { lines, log } = capture();
    const handler = withRequestLog(async () => new Response(null, { status: 204 }), log);
    await handler(
      new Request('https://api.test/api/me', {
        headers: { 'x-request-id': '","status":200,"x":"' },
      })
    );
    expect(lines[0].requestId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps a request id the caller sent', async () => {
    const { lines, log } = capture();
    const handler = withRequestLog(async () => new Response(null, { status: 204 }), log);
    const response = await handler(
      new Request('https://api.test/api/me', { headers: { 'x-request-id': 'abc123' } })
    );
    expect(lines[0].requestId).toBe('abc123');
    expect(response.headers.get('X-Request-Id')).toBe('abc123');
  });

  it('writes JSON lines to the console by default', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withRequestLog(async () => new Response('ok'))(new Request('https://api.test/api/me'));
    expect(JSON.parse(out.mock.calls[0][0] as string)).toMatchObject({ event: 'request' });
    out.mockRestore();
  });
});
