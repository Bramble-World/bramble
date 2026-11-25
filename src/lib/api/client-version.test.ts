import { describe, expect, it, vi } from 'vitest';
import { CLIENT_HEADER, clientShowsEndings, parseClientHeader } from './client-version';

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

  /** Bramble for Mac has ended: whatever the build, the Mac is refused. */
  it.each(['macos/1.0 (11)', 'macos/0.1 (1)', 'macos/9.9 (999)'])('refuses %s', async (header) => {
    const { assertClientSupported } = await import('./client-version');

    expect(() => assertClientSupported(request(header))).toThrow(/too old/i);
  });

  it.each([
    ['no header', undefined],
    ['an unparseable header', 'something-else'],
    ['a build number it cannot read', 'macos/1.2 (beta)'],
    ['the iPhone', 'ios/1.1 (35)'],
  ])('serves a request with %s', async (_label, header) => {
    const { assertClientSupported } = await import('./client-version');

    expect(() => assertClientSupported(request(header))).not.toThrow();
  });
});

describe('the refusal itself', () => {
  it('is a 426 in the standard envelope', async () => {
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

describe('clientShowsEndings', () => {
  const from = (header?: string) =>
    new Request('http://api.test/api/v1/sessions/x/turn', {
      headers: header ? { [CLIENT_HEADER]: header } : {},
    });

  it('keeps stories open on the Mac, which cannot show an ending', () => {
    expect(clientShowsEndings(from('macos/1.0 (11)'))).toBe(false);
  });

  it('ends stories everywhere else, including a client that does not say', () => {
    expect(clientShowsEndings(from('ios/1.2 (40)'))).toBe(true);
    expect(clientShowsEndings(from())).toBe(true);
    expect(clientShowsEndings(from('not a header'))).toBe(true);
  });
});
