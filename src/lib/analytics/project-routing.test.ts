// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const made: string[] = [];
const fetchMock = vi.fn(async () => new Response('{}'));

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(token: string) {
      made.push(token);
    }
    captureImmediate = async () => {};
  },
}));

const env: Record<string, string | undefined> = {};
vi.mock('@/env', () => ({ env }));

const { getAnalytics, resetAnalytics } = await import('./analytics');
const { withRequestClient } = await import('./client-context');
const { deleteAnalyticsPerson } = await import('./person-deletion');

const from = (client?: string) =>
  new Request('http://test', { headers: client ? { 'x-bramble-client': client } : {} });

beforeEach(() => {
  made.length = 0;
  resetAnalytics();
  Object.assign(env, {
    POSTHOG_PROJECT_TOKEN: 'main',
    POSTHOG_IOS_PROJECT_TOKEN: 'ios',
    POSTHOG_PERSONAL_API_KEY: 'phx',
    POSTHOG_PROJECT_ID: '1',
    POSTHOG_IOS_PROJECT_ID: '2',
    POSTHOG_API_HOST: 'https://posthog.test',
  });
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('which project an event goes to', () => {
  it('sends an iPhone request to the iOS project, across awaits', async () => {
    await withRequestClient(from('ios/1.0 (5)'), async () => {
      await Promise.resolve();
      getAnalytics();
    });
    expect(made).toEqual(['ios']);
  });

  it.each([
    ['the Mac', 'macos/1.2 (57)'],
    ['a client that sent no header', undefined],
  ])('sends %s to the main project', (_name, header) => {
    withRequestClient(from(header), () => getAnalytics());
    expect(made).toEqual(['main']);
  });

  it('sends work outside a request to the main project', () => {
    getAnalytics();
    expect(made).toEqual(['main']);
  });

  it('shares the main project where iOS has no token', () => {
    env.POSTHOG_IOS_PROJECT_TOKEN = undefined;
    withRequestClient(from('ios/1.0 (5)'), () => getAnalytics());
    expect(made).toEqual(['main']);
  });

  it('sends nothing with no main token, whatever the client', () => {
    env.POSTHOG_PROJECT_TOKEN = undefined;
    const sink = withRequestClient(from('ios/1.0 (5)'), () => getAnalytics());
    expect(sink.enabled).toBe(false);
  });
});

describe('deleting a person', () => {
  const urls = () => fetchMock.mock.calls.map((call: unknown[]) => String(call[0]));

  it('asks both projects', async () => {
    await deleteAnalyticsPerson('USER');
    expect(urls()).toEqual([
      'https://posthog.test/api/environments/1/persons/bulk_delete/',
      'https://posthog.test/api/environments/2/persons/bulk_delete/',
    ]);
  });

  it('fails when either project refuses', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}'));
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 403 }));
    await expect(deleteAnalyticsPerson('USER')).rejects.toThrow('403');
  });

  it('fails closed with an iOS token and no iOS project id', async () => {
    env.POSTHOG_IOS_PROJECT_ID = undefined;
    await expect(deleteAnalyticsPerson('USER')).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
