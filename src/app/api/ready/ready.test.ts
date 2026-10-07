import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The readiness probe's only job: answer 503 when a dependency is not there.
 *
 * Both dependencies are faked, because what is under test is the decision rather
 * than the queries. `select 1` and `PING` are not interesting; whether an
 * unreachable Redis takes this replica out of rotation is, and the only way to
 * test that against a real Redis is to stop it.
 */
vi.mock('@/index', () => ({ db: { execute: vi.fn() } }));
vi.mock('@/lib/redis/client', () => ({ redis: vi.fn() }));

const { GET } = await import('./route');
const { db } = vi.mocked(await import('@/index'));
const { redis } = vi.mocked(await import('@/lib/redis/client'));

/** Nothing in the probe's path touches more of a Redis client than `ping`. */
const redisThat = (ping: () => Promise<unknown>) => redis.mockReturnValue({ ping } as never);
const pg = (execute: () => Promise<unknown>) => db.execute.mockImplementation(execute as never);

const up = () => Promise.resolve();
const down = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.1.4:6379'));
const hangs = () => new Promise(() => {});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('GET /api/ready', () => {
  it('answers 200 when both dependencies answer', async () => {
    pg(up);
    redisThat(up);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ status: 'ok' });
  });

  /**
   * The import path cannot accept a transcript without Redis, so a replica that
   * has lost it serves errors. Better to leave the rotation than to stay in it.
   */
  it('answers 503 and names Redis when Redis is down', async () => {
    pg(up);
    redisThat(down);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      status: 'unavailable',
      failed: ['redis'],
    });
  });

  it('answers 503 and names Postgres when Postgres is down', async () => {
    pg(down);
    redisThat(up);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ failed: ['postgres'] });
  });

  it('names both when both are down', async () => {
    pg(down);
    redisThat(down);

    expect((await (await GET()).json()).failed).toStrictEqual(['postgres', 'redis']);
  });

  /**
   * A hung dependency is the case the timeout exists for, and the worse of the
   * two failures: a refused connection fails fast, while a probe waiting on a
   * pool that will never hand out a connection never answers at all — and a
   * probe that never answers is a replica that never leaves rotation.
   */
  it('answers 503 rather than hanging when a dependency never replies', async () => {
    vi.useFakeTimers();
    pg(up);
    redisThat(hangs);

    const pending = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ failed: ['redis'] });
  });

  /**
   * The failure must not carry the error. Both clients put their connection
   * string into the message — `connect ECONNREFUSED 10.0.1.4:6379` is the mild
   * version, and an auth failure includes credentials.
   */
  it('reports the check that failed and never the error behind it', async () => {
    pg(up);
    redisThat(down);

    const body = JSON.stringify(await (await GET()).json());

    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('10.0.1.4');
  });
});
