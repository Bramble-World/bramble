import { describe, expect, it, vi } from 'vitest';
import { CLIENT_HEADER, parseClientHeader } from './client-version';

/**
 * The version gate.
 *
 * Most of these assert that something is *let through*, which is the half that
 * matters: a gate that refuses what it does not recognise takes the product off
 * the air to enforce a version policy.
 */
describe('reading the header', () => {
  it('reads the shape the Mac sends', () => {
    expect(parseClientHeader('macos/1.2 (57)')).toStrictEqual({
      platform: 'macos',
      version: '1.2',
      build: 57,
    });
  });

  it.each([
    ['extra spacing', 'macos/1.2   (57)  '],
    ['an odd case', 'MacOS/1.2 (57)'],
    ['a long version', 'macos/1.2.3-beta.4 (57)'],
  ])('reads %s', (_label, header) => {
    expect(parseClientHeader(header)).toMatchObject({ platform: 'macos', build: 57 });
  });

  /**
   * Null is the ordinary answer, not a failure: the web app sends nothing, curl
   * sends nothing, and a Mac build from before the header existed sends nothing.
   */
  it.each([
    ['nothing at all', null],
    ['an empty string', ''],
    ['no build number', 'macos/1.2'],
    ['a non-numeric build', 'macos/1.2 (beta)'],
    ['a bare version', '1.2 (57)'],
    ['something else entirely', 'Mozilla/5.0 (Macintosh)'],
    ['a build that is not an integer', 'macos/1.2 (5.7)'],
  ])('returns null for %s', (_label, header) => {
    expect(parseClientHeader(header)).toBeNull();
  });

  // Another platform is not something this minimum has an opinion about.
  it('reads a platform it does not gate', () => {
    expect(parseClientHeader('ios/3.0 (12)')).toMatchObject({ platform: 'ios', build: 12 });
  });
});

describe('the gate', () => {
  const request = (header?: string) =>
    new Request('http://api.test/api/v1/world', {
      headers: header ? { [CLIENT_HEADER]: header } : {},
    });

  async function withMinimum(MIN_MACOS_BUILD: number) {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { MIN_MACOS_BUILD } }));
    return import('./client-version');
  }

  it('refuses a build below the minimum', async () => {
    const { assertClientSupported } = await withMinimum(57);

    expect(() => assertClientSupported(request('macos/1.1 (56)'))).toThrow(/too old/i);
  });

  // The minimum is the oldest *supported* build, not the oldest refused one.
  it('serves a build exactly at the minimum', async () => {
    const { assertClientSupported } = await withMinimum(57);

    expect(() => assertClientSupported(request('macos/1.2 (57)'))).not.toThrow();
  });

  it('serves a build above the minimum', async () => {
    const { assertClientSupported } = await withMinimum(57);

    expect(() => assertClientSupported(request('macos/1.3 (58)'))).not.toThrow();
  });

  it.each([
    ['no header', undefined],
    ['an unparseable header', 'something-else'],
    ['a build number it cannot read', 'macos/1.2 (beta)'],
    ['a platform it does not gate', 'ios/0.1 (1)'],
  ])('serves a request with %s', async (_label, header) => {
    const { assertClientSupported } = await withMinimum(57);

    expect(() => assertClientSupported(request(header))).not.toThrow();
  });

  /**
   * Unset means off. A misconfiguration here would lock out every client at
   * once, so the failure mode has to be "serve everyone".
   */
  it('serves everything when the gate is unset', async () => {
    const { assertClientSupported } = await withMinimum(0);

    expect(() => assertClientSupported(request('macos/0.1 (1)'))).not.toThrow();
  });

  /**
   * With the gate off there is no answer the header could change, so it is not
   * read at all — which is the whole of what the zero check buys, since no build
   * can be below zero. Asserted directly because the behaviour is otherwise
   * identical either way.
   */
  it('does not even read the header when the gate is unset', async () => {
    const { assertClientSupported } = await withMinimum(0);
    const req = request('macos/0.1 (1)');
    const read = vi.spyOn(req.headers, 'get');

    assertClientSupported(req);

    expect(read).not.toHaveBeenCalled();
  });
});

describe('the refusal itself', () => {
  it('is a 426 in the standard envelope', async () => {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { MIN_MACOS_BUILD: 57 } }));
    const { assertClientSupported } = await import('./client-version');
    const { handleError } = await import('@/lib/utils/api.handler-errors');

    let response: Response | undefined;
    try {
      assertClientSupported(
        new Request('http://api.test/api/v1/world', { headers: { [CLIENT_HEADER]: 'macos/1 (1)' } })
      );
    } catch (error) {
      response = handleError(error);
    }

    expect(response!.status).toBe(426);
    await expect(response!.json()).resolves.toStrictEqual({
      error: {
        code: 'CLIENT_TOO_OLD',
        message: 'This version of Bramble is too old. Please update.',
      },
    });
  });
});
