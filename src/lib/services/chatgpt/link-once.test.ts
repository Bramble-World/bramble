import { describe, expect, it } from 'vitest';
import { linkKey, once, type LinkStore } from './link-once';
import { memoryLinks } from './link-once.memory';

describe('once', () => {
  it('works it out the first time, and answers a repeat from memory', async () => {
    const store = memoryLinks();
    let runs = 0;
    const work = async () => ({ outcome: 'queued', stories: ++runs });
    expect(await once(store, 'k', work)).toEqual({ outcome: 'queued', stories: 1 });
    expect(await once(store, 'k', work)).toEqual({ outcome: 'queued', stories: 1 });
    expect(runs).toBe(1);
  });

  it('makes a repeat sent while the first is running wait for it', async () => {
    const store = memoryLinks();
    let runs = 0;
    let finish: (value: { stories: number }) => void = () => {};
    const first = once(store, 'k', () => {
      runs += 1;
      return new Promise<{ stories: number }>((resolve) => (finish = resolve));
    });
    await Promise.resolve();
    const second = once(store, 'k', async () => ({ stories: 99 }), { pollMs: 5 });
    finish({ stories: 2 });
    expect(await first).toEqual({ stories: 2 });
    expect(await second).toEqual({ stories: 2 });
    expect(runs).toBe(1);
  });

  it('forgets an answer it was told not to keep, and a failure', async () => {
    const store = memoryLinks();
    await once(store, 'k', async () => ({ outcome: 'limited' }), { keep: () => false });
    expect(store.keys.has('k')).toBe(false);
    await expect(once(store, 'k', async () => Promise.reject(new Error('down')))).rejects.toThrow(
      'down'
    );
    expect(store.keys.has('k')).toBe(false);
  });

  it('writes every time with no store, and when the store is down', async () => {
    let runs = 0;
    const work = async () => ++runs;
    await once(null, 'k', work);
    await once(null, 'k', work);
    const down = {
      ...memoryLinks(),
      set: async () => Promise.reject(new Error('no redis')),
    } as unknown as LinkStore;
    await once(down, 'k', work);
    expect(runs).toBe(3);
  });
});

describe('linkKey', () => {
  it('is per account and per note, ignores surrounding space, and never holds the note', () => {
    const key = linkKey('user-a', ' my ex texted me ');
    expect(key).toBe(linkKey('user-a', 'my ex texted me'));
    expect(key).not.toBe(linkKey('user-b', 'my ex texted me'));
    expect(key).not.toBe(linkKey('user-a', 'my ex called me'));
    expect(key).not.toContain('ex');
    expect(key).toMatch(/^chatgpt-link:[0-9a-f]{64}$/);
  });
});
