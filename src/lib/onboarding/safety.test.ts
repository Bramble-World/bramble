import { describe, expect, it, vi } from 'vitest';
import { UpstreamBusyError } from '@/lib/utils/errors';
import {
  createModerationCheck,
  FLAGGING_CATEGORIES,
  isFlagged,
  IPHONE_WAIT_MS,
  SAFETY_CHECK_ATTEMPTS_MS,
} from './safety';

const ANSWER = 'my brother hit me when i was little';

function moderation(categories: Record<string, boolean>, status = 200) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ results: [{ flagged: true, categories }] }), { status })
  );
}

describe('isFlagged', () => {
  it.each(FLAGGING_CATEGORIES)('flags %s', (category) => {
    expect(isFlagged({ [category]: true })).toBe(true);
  });

  it.each(['harassment', 'hate', 'sexual', 'illicit'])(
    'lets %s through: a story, not a crisis',
    (category) => {
      expect(isFlagged({ [category]: true })).toBe(false);
    }
  );

  it('passes an answer with nothing flagged', () => {
    expect(isFlagged({ 'self-harm': false, violence: false })).toBe(false);
  });
});

describe('createModerationCheck', () => {
  it("asks OpenAI's moderation endpoint, and says what it found", async () => {
    const fetchImpl = moderation({ violence: true });
    await expect(createModerationCheck('sk-test', fetchImpl)(ANSWER)).resolves.toEqual({
      flagged: true,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/moderations');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'omni-moderation-latest',
      input: ANSWER,
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes what moderation passes', async () => {
    await expect(
      createModerationCheck('sk-test', moderation({ violence: false }))(ANSWER)
    ).resolves.toEqual({
      flagged: false,
    });
  });

  it.each([
    ['OpenAI down', async () => new Response('oops', { status: 500 })],
    ['OpenAI busy', async () => new Response('slow down', { status: 429 })],
    ['an unknown reply', async () => new Response(JSON.stringify({ nope: true }), { status: 200 })],
    ['no reply in time', async () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])(
    'is busy, never a pass, on %s, and the error never carries the answer',
    async (_case, reply) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = await createModerationCheck(
        'sk-test',
        vi.fn<typeof fetch>(reply)
      )(ANSWER).catch((e) => e);
      expect(error).toBeInstanceOf(UpstreamBusyError);
      expect(JSON.stringify({ message: error.message, cause: error.cause })).not.toContain(
        'brother'
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('brother');
      warn.mockRestore();
    }
  );

  it('gives both tries less than the iPhone waits, with room for the round trip', () => {
    const total = SAFETY_CHECK_ATTEMPTS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(IPHONE_WAIT_MS - 400);
  });

  it('tries once more when the first try times out, and answers from the second', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ categories: { 'self-harm': true } }] }), {
          status: 200,
        })
      );

    await expect(createModerationCheck('sk-test', fetchImpl)(ANSWER)).resolves.toEqual({
      flagged: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('brother');
    warn.mockRestore();
  });

  it('tries once more when OpenAI fails on its side, but not when it says slow down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ categories: {} }] }), { status: 200 })
      );
    await expect(createModerationCheck('sk-test', down)(ANSWER)).resolves.toEqual({
      flagged: false,
    });
    expect(down).toHaveBeenCalledTimes(2);

    const busy = vi.fn<typeof fetch>(async () => new Response('slow down', { status: 429 }));
    await expect(createModerationCheck('sk-test', busy)(ANSWER)).rejects.toBeInstanceOf(
      UpstreamBusyError
    );
    expect(busy).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
