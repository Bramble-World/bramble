import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The beta gate.
 *
 * Redis is faked here because what these assert is the decision logic — which
 * code opens the door, what the page is told when it does not, and that nothing
 * leaks before a correct answer. The throttle's own behaviour is asserted
 * through the fake's call log rather than against a real server.
 */
const incr = vi.fn();
const expire = vi.fn();
vi.mock('@/lib/redis/client', () => ({
  redis: () => ({ incr, expire }),
  resetRedis: vi.fn(),
}));

const CODE = 'bramble-beta-2026';
const URL_ = 'https://downloads.example.com/Bramble-0.3.1.dmg';

async function load(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('@/env', () => ({
    env: {
      BETA_ACCESS_CODE: CODE,
      MACOS_DOWNLOAD_URL: URL_,
      MACOS_BUILD_LABEL: null,
      ...overrides,
    },
  }));
  return import('./beta-access');
}

beforeEach(() => {
  vi.clearAllMocks();
  incr.mockResolvedValue(1);
  expire.mockResolvedValue(1);
});

describe('the gate', () => {
  it('returns the download for the right code', async () => {
    const { checkBetaCode } = await load();

    expect(await checkBetaCode(CODE, '1.2.3.4')).toStrictEqual({
      ok: true,
      url: URL_,
      label: null,
    });
  });

  it('is forgiving about case and stray whitespace', async () => {
    const { checkBetaCode } = await load();

    expect((await checkBetaCode(`  ${CODE.toUpperCase()}  `, '1.2.3.4')).ok).toBe(true);
  });

  /**
   * The assertion the whole module exists for: nothing about the build reaches a
   * caller who has not answered. A wrong code must not carry the URL in a field
   * the page forgets to hide.
   */
  it('reveals nothing at all for a wrong code', async () => {
    const { checkBetaCode } = await load();

    const result = await checkBetaCode('not-the-code', '1.2.3.4');

    expect(result).toStrictEqual({ ok: false, reason: 'wrong' });
    expect(JSON.stringify(result)).not.toContain(URL_);
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it('reveals nothing for a code of a different length', async () => {
    const { checkBetaCode } = await load();

    expect(await checkBetaCode('x', '1.2.3.4')).toStrictEqual({ ok: false, reason: 'wrong' });
  });

  /**
   * An unconfigured deployment says the beta is closed *before* comparing
   * anything, so it cannot be probed for a code that does not exist yet.
   */
  it.each([
    ['no code configured', { BETA_ACCESS_CODE: undefined }],
    ['no download configured', { MACOS_DOWNLOAD_URL: undefined }],
  ])('reports the beta closed when there is %s', async (_label, overrides) => {
    const { checkBetaCode } = await load(overrides);

    expect(await checkBetaCode(CODE, '1.2.3.4')).toStrictEqual({ ok: false, reason: 'closed' });
    expect(incr).not.toHaveBeenCalled();
  });

  it('passes the build label through when one is set', async () => {
    const { checkBetaCode } = await load({ MACOS_BUILD_LABEL: '0.3.1 (beta)' });

    expect(await checkBetaCode(CODE, '1.2.3.4')).toMatchObject({ label: '0.3.1 (beta)' });
  });
});

describe('throttling', () => {
  /**
   * A short shared code with unlimited guesses falls in minutes, which would
   * make the gate theatre.
   */
  it('refuses once too many attempts come from one address', async () => {
    const { checkBetaCode } = await load();
    incr.mockResolvedValue(11);

    // Even the correct code is refused — the point is to stop the guessing, and
    // a correct guess on attempt 500 is exactly what is being stopped.
    expect(await checkBetaCode(CODE, '1.2.3.4')).toStrictEqual({ ok: false, reason: 'throttled' });
  });

  it('counts per address, keyed so one tester cannot lock out another', async () => {
    const { checkBetaCode } = await load();

    await checkBetaCode('wrong', '1.2.3.4');
    await checkBetaCode('wrong', '5.6.7.8');

    expect(incr).toHaveBeenNthCalledWith(1, 'beta-access:1.2.3.4');
    expect(incr).toHaveBeenNthCalledWith(2, 'beta-access:5.6.7.8');
  });

  /**
   * The window starts at the first guess and does not slide. Refreshing the
   * expiry on every attempt would let a persistent guesser keep their own
   * lockout alive forever and never serve it.
   */
  it('sets the window once, on the first attempt only', async () => {
    const { checkBetaCode } = await load();

    incr.mockResolvedValueOnce(1);
    await checkBetaCode('wrong', '1.2.3.4');
    incr.mockResolvedValueOnce(2);
    await checkBetaCode('wrong', '1.2.3.4');

    expect(expire).toHaveBeenCalledTimes(1);
  });

  /**
   * Fails open. A throttle that cannot reach its store should not take the
   * download offline for every tester — the code is still required either way.
   */
  it('still lets a correct code through when Redis is down', async () => {
    const { checkBetaCode } = await load();
    incr.mockRejectedValue(new Error('connection refused'));

    expect((await checkBetaCode(CODE, '1.2.3.4')).ok).toBe(true);
  });
});
