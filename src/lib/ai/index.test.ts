import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Which generator a process gets.
 *
 * This is the guard on spend. CI runs every gate with no secrets, and the
 * Database job drives the pipeline against a real schema — so "no key" has to
 * resolve to the fake automatically rather than through a flag somebody has to
 * remember. Getting this backwards would not fail; it would bill.
 */
afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/env');
});

async function loadWith(env: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('@/env', () => ({ env }));
  return import('./index');
}

describe('getGenerator', () => {
  it('uses the fake when no key is configured', async () => {
    const ai = await loadWith({ OPENAI_API_KEY: undefined });

    // getFakeGenerator throws unless the fake is the one actually selected, so
    // this asserts the selection rather than just the type.
    expect(() => ai.getFakeGenerator()).not.toThrow();
  });

  it('uses the live client when a key is configured', async () => {
    const ai = await loadWith({ OPENAI_API_KEY: 'sk-test-key' });

    expect(() => ai.getFakeGenerator()).toThrow(/live client is selected/);
  });

  // For playing the loop end to end locally without paying for it.
  it('honours an explicit fake mode even with a key present', async () => {
    const ai = await loadWith({ OPENAI_API_KEY: 'sk-test-key', BRAMBLE_AI_MODE: 'fake' });

    expect(() => ai.getFakeGenerator()).not.toThrow();
  });

  // The fake holds registered fixtures and the live client holds a connection
  // pool, so handing out a fresh instance per call would silently lose both.
  it('returns the same instance across calls', async () => {
    const ai = await loadWith({ OPENAI_API_KEY: undefined });

    expect(ai.getGenerator()).toBe(ai.getGenerator());
  });

  it('drops memoised instances on reset', async () => {
    const ai = await loadWith({ OPENAI_API_KEY: undefined });

    const first = ai.getGenerator();
    ai.resetGenerators();
    expect(ai.getGenerator()).not.toBe(first);
  });
});
