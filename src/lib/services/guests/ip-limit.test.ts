import { describe, expect, it } from 'vitest';
import { RateLimitError } from '@/lib/utils/errors';
import { assertUnderIpLimit, clientIp, type CounterStore } from './ip-limit';

/**
 * An in-memory stand-in for the three Redis commands, with a clock the test
 * moves. Enough of their semantics to matter: SET NX only when absent, INCR
 * keeps the expiry, an expired key is gone.
 */
function fakeStore() {
  let now = 0;
  const keys = new Map<string, { value: number; expiresAt: number }>();
  const live = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.expiresAt <= now) keys.delete(key);
    return keys.get(key);
  };
  const store = {
    // Called as set(key, value, 'EX', seconds, 'NX'); only the NX form exists here.
    async set(key: string, value: number, ...[, seconds]: [string, number, string]) {
      if (live(key)) return null;
      keys.set(key, { value, expiresAt: now + seconds * 1000 });
      return 'OK';
    },
    async incr(key: string) {
      const entry = live(key) ?? { value: 0, expiresAt: Infinity };
      entry.value += 1;
      keys.set(key, entry);
      return entry.value;
    },
    async ttl(key: string) {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === Infinity ? -1 : Math.ceil((entry.expiresAt - now) / 1000);
    },
  };
  return {
    store: store as unknown as CounterStore,
    advance: (ms: number) => (now += ms),
  };
}

describe('assertUnderIpLimit', () => {
  it('allows up to the limit, then refuses with the time left in the window', async () => {
    const { store, advance } = fakeStore();
    for (let i = 0; i < 3; i++) await assertUnderIpLimit('guests', '1.2.3.4', 3, 3600, store);

    advance(600_000);
    const error = await assertUnderIpLimit('guests', '1.2.3.4', 3, 3600, store).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(3000);
  });

  it('opens again once the window has passed', async () => {
    const { store, advance } = fakeStore();
    for (let i = 0; i < 3; i++) await assertUnderIpLimit('guests', '1.2.3.4', 3, 3600, store);
    await expect(assertUnderIpLimit('guests', '1.2.3.4', 3, 3600, store)).rejects.toBeInstanceOf(
      RateLimitError
    );

    advance(3600_000);
    await expect(assertUnderIpLimit('guests', '1.2.3.4', 3, 3600, store)).resolves.toBeUndefined();
  });

  it('counts each address and each bucket on its own', async () => {
    const { store } = fakeStore();
    await assertUnderIpLimit('guests', '1.2.3.4', 1, 3600, store);
    await expect(assertUnderIpLimit('guests', '5.6.7.8', 1, 3600, store)).resolves.toBeUndefined();
    await expect(
      assertUnderIpLimit('guest-challenges', '1.2.3.4', 1, 3600, store)
    ).resolves.toBeUndefined();
    await expect(assertUnderIpLimit('guests', '1.2.3.4', 1, 3600, store)).rejects.toBeInstanceOf(
      RateLimitError
    );
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => new Request('http://x.test', { headers });

  it('takes the first X-Forwarded-For entry, the client as the ingress saw it', () => {
    expect(clientIp(req({ 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.2, 10.0.0.3' }))).toBe(
      '203.0.113.9'
    );
  });

  it('falls back to X-Real-IP, then to one shared bucket', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.10' }))).toBe('203.0.113.10');
    expect(clientIp(req({}))).toBe('unknown');
  });
});
