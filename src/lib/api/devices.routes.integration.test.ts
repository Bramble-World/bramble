import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

/** The device routes against a real database. Only the session and Apple are stubbed. */
vi.mock('@/lib/services/auth/auth.service', () => ({ requireCurrentUser: vi.fn() }));
vi.mock('@/lib/services/push/apns', () => ({ sendPush: vi.fn() }));

const { db } = await import('@/index');
const { pushDevices, users } = await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const apns = vi.mocked(await import('@/lib/services/push/apns'));
const { sendToUser } = await import('@/lib/services/push/push.service');
const route = await import('@/app/api/v1/me/devices/route');

const context = {} as never;
const IDS = ['user_device_a', 'user_device_b'];
const TOKEN = 'ab'.repeat(32);
const body = { token: TOKEN, environment: 'production', timeZone: 'America/New_York' };

let a: string;
let b: string;

function request(method: string, payload: unknown) {
  return new Request('http://test/api/v1/me/devices', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function signIn(id: string, isGuest = false) {
  auth.requireCurrentUser.mockResolvedValue({ id, isGuest } as never);
}

const rows = (userId: string) =>
  db.select().from(pushDevices).where(eq(pushDevices.userId, userId));

beforeAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, IDS));
  [{ id: a }, { id: b }] = await db
    .insert(users)
    .values([
      { clerkId: IDS[0], email: 'device-a@test.local' },
      { clerkId: IDS[1], email: 'device-b@test.local' },
    ])
    .returning({ id: users.id });
});

beforeEach(async () => {
  await db.delete(pushDevices).where(inArray(pushDevices.userId, [a, b]));
  apns.sendPush.mockReset();
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.clerkId, IDS));
});

describe('PUT /api/v1/me/devices', () => {
  it('registers an install, and sending it again updates that row', async () => {
    signIn(a);
    expect((await route.PUT(request('PUT', body), context)).status).toBe(200);
    await route.PUT(request('PUT', { ...body, timeZone: 'Europe/London' }), context);

    const [row, ...rest] = await rows(a);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ token: TOKEN, timeZone: 'Europe/London' });
  });

  it('moves a token to whoever signed in last', async () => {
    signIn(a);
    await route.PUT(request('PUT', body), context);
    signIn(b);
    await route.PUT(request('PUT', body), context);

    expect(await rows(a)).toEqual([]);
    expect(await rows(b)).toHaveLength(1);
  });

  it('stores one token however it is cased', async () => {
    signIn(a);
    await route.PUT(request('PUT', { ...body, token: TOKEN.toUpperCase() }), context);
    expect((await rows(a))[0].token).toBe(TOKEN);
  });

  it('refuses a guest', async () => {
    signIn(a, true);
    const response = await route.PUT(request('PUT', body), context);
    expect(response.status).toBe(403);
    expect(await rows(a)).toEqual([]);
  });

  it.each([
    ['a token that is not hex', { token: 'not-a-token' }],
    ['an unknown environment', { environment: 'staging' }],
    ['an unknown time zone', { timeZone: 'Mars/Olympus' }],
  ])('refuses %s', async (_name, change) => {
    signIn(a);
    const response = await route.PUT(request('PUT', { ...body, ...change }), context);
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/v1/me/devices', () => {
  it("removes only the caller's own token", async () => {
    signIn(a);
    await route.PUT(request('PUT', body), context);

    signIn(b);
    const other = await route.DELETE(request('DELETE', { token: TOKEN }), context);
    expect(await other.json()).toMatchObject({ removed: false });
    expect(await rows(a)).toHaveLength(1);

    signIn(a);
    const own = await route.DELETE(request('DELETE', { token: TOKEN }), context);
    expect(await own.json()).toMatchObject({ removed: true });
    expect(await rows(a)).toEqual([]);
  });
});

describe('sendToUser', () => {
  const message = { title: 'bramble', body: 'test' };

  it('deletes a dead token and keeps one that merely failed', async () => {
    const dead = 'cd'.repeat(32);
    signIn(a);
    await route.PUT(request('PUT', body), context);
    await route.PUT(request('PUT', { ...body, token: dead }), context);
    apns.sendPush.mockImplementation(async ({ token }) =>
      token === dead
        ? { kind: 'gone', reason: 'Unregistered' }
        : { kind: 'failed', reason: 'TooManyRequests' }
    );

    const result = await sendToUser(a, message);

    expect(result).toEqual({ delivered: 0, removed: 1, failed: ['TooManyRequests'] });
    expect((await rows(a)).map((row) => row.token)).toEqual([TOKEN]);
  });

  it('counts what was delivered', async () => {
    signIn(a);
    await route.PUT(request('PUT', body), context);
    apns.sendPush.mockResolvedValue({ kind: 'delivered' });
    expect(await sendToUser(a, message)).toEqual({ delivered: 1, removed: 0, failed: [] });
  });
});
