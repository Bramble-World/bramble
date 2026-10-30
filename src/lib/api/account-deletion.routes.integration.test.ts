import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { SignJWT, exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from 'jose';

/**
 * Deleting an account from the app, end to end: `DELETE /api/v1/me` against a
 * real database, through the real route, auth dispatch and cascade.
 *
 * Stubbed at the edges only:
 *
 * - **Clerk.** The session (`requireCurrentUser` resolving to the account's
 *   real row, and the first-factor age the session token would carry) and the backend client's `getUser` and
 *   `deleteUser`.
 * - **Apple and PostHog**, as `fetch`. Every call is recorded and answered the
 *   way Apple's /auth/token and /auth/revoke and PostHog's bulk_delete answer,
 *   so the test checks what was sent — including that the client secret is a
 *   JWT signed with the configured key, verified here with its public half.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  // A plain object, so the key can be generated in beforeAll and set on it.
  return {
    env: {
      ...actual.env,
      BRAMBLE_AI_MODE: 'fake',
      APPLE_TEAM_ID: 'TEAMID1234',
      APPLE_SIGN_IN_KEY_ID: 'KEYID12345',
      APPLE_SIGN_IN_CLIENT_ID: 'com.brambleworld.BrambleMobile',
      POSTHOG_PROJECT_TOKEN: 'phc_test',
      POSTHOG_PERSONAL_API_KEY: 'phx_test',
      POSTHOG_PROJECT_ID: '4242',
      POSTHOG_API_HOST: 'https://posthog.test',
    },
  };
});
vi.mock('@/lib/services/auth/auth.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/auth.service')>();
  return { ...actual, requireCurrentUser: vi.fn(), clerkFirstFactorAgeMinutes: vi.fn() };
});
// Capturing is not under test, and with a project token set it would post to
// PostHog's ingestion host through the stubbed fetch.
vi.mock('@/lib/analytics/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/analytics')>();
  return { ...actual, track: async () => {}, trackAlias: async () => {} };
});
vi.mock('@/lib/services/auth/auth.client', () => ({
  clerkBackend: { users: { getUser: vi.fn(), deleteUser: vi.fn() } },
}));

const { env } = await import('@/env');
const { db } = await import('@/index');
const { imports, users } = await import('@/db/schema/tables');
const auth = vi.mocked(await import('@/lib/services/auth/auth.service'));
const { clerkBackend } = await import('@/lib/services/auth/auth.client');
const clerk = vi.mocked(clerkBackend.users);
const { createFakeGenerator } = await import('@/lib/ai');
const { registerFixtures } = await import('@/lib/ai/fixtures');
const persons = await import('@/lib/services/persons/persons.service');
const storylines = await import('@/lib/services/storylines/storylines.service');
const sessions = await import('@/lib/services/sessions/sessions.service');
const timeline = await import('@/lib/services/timeline/timeline.service');
const motifs = await import('@/lib/services/motifs/motifs.service');
const { generateTurn } = await import('@/lib/services/generation/turns.service');
const meRoute = await import('@/app/api/v1/me/route');

const APPLE_SUB = '001234.apple-user.0001';
const CLERK_IDS = [
  'user_delete_apple',
  'user_delete_email',
  'user_delete_gone',
  'user_delete_stale',
  'user_delete_bystander',
];

let applePublicKey: CryptoKey;
const calls: Array<{ url: string; body: string; authorization: string | null }> = [];
/** What Apple says to the next code; a test can make it refuse. */
let appleTokenStatus = 200;

async function idToken(sub: string): Promise<string> {
  // Apple signs these; the server reads `sub` without verifying (see
  // apple-sign-in.ts), so any key will do here.
  return new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  calls.push({ url, body: String(init?.body ?? ''), authorization: headers.get('authorization') });
  if (url === 'https://appleid.apple.com/auth/token') {
    if (appleTokenStatus !== 200) {
      return Response.json({ error: 'invalid_grant' }, { status: appleTokenStatus });
    }
    const code = new URLSearchParams(String(init?.body)).get('code');
    const sub = code === 'code-for-someone-else' ? 'another.apple.user' : APPLE_SUB;
    return Response.json({
      access_token: 'apple-access',
      refresh_token: 'apple-refresh-token',
      id_token: await idToken(sub),
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
  if (url === 'https://appleid.apple.com/auth/revoke') return new Response(null, { status: 200 });
  if (url === 'https://posthog.test/api/environments/4242/persons/bulk_delete/') {
    return new Response(null, { status: 202 });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

/** An account that touches every kind of row, as purge.integration.test.ts builds. */
async function makeAccount(clerkId: string): Promise<{ userId: string; storylineId: string }> {
  const [user] = await db
    .insert(users)
    .values({ clerkId, email: `${clerkId}@delete.local` })
    .returning({ id: users.id });
  const userId = user.id;

  const storyline = await storylines.createStoryline(userId, {
    title: 'The Unsent Apology',
    sourceSurface: 'imessage',
    tone: 'wistful',
  });
  await storylines.markStatus(userId, storyline.id, 'ready');
  const self = await persons.getOrCreateSelfPerson(userId, 'Blossom');
  const maya = await persons.getOrCreatePersonByHandle(userId, 'c_0123456789abcdef', 'Maya');
  const a = await storylines.castCharacter(userId, storyline.id, self.id, { role: 'protagonist' });
  const b = await storylines.castCharacter(userId, storyline.id, maya.id);
  await storylines.relateCharacters(userId, storyline.id, a.id, b.id, { closeness: 'was close' });
  await timeline.appendEvent(userId, storyline.id, {
    origin: 'extracted',
    title: 'Where things stood',
    description: 'They had not spoken in three weeks.',
    participantCharacterIds: [a.id, b.id],
  });
  await motifs.createMotif(userId, { label: 'the lasagna incident' }, [self.id, maya.id]);
  await db
    .insert(imports)
    .values({ userId, conversationKey: `conv-${clerkId}`, storylineId: storyline.id });

  const fake = createFakeGenerator();
  registerFixtures(fake);
  const session = await sessions.startSession(userId, storyline.id);
  await generateTurn(userId, session.id, { generator: fake });

  return { userId, storylineId: storyline.id };
}

async function tablesWithColumn(column: string): Promise<string[]> {
  const result = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = ${column}
  `);
  return result.rows.map((r) => r.table_name);
}

async function rowsWhere(table: string, column: string, id: string): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${id}`
  );
  return result.rows[0].n;
}

/** Every row the account owns, across every table that could hold one. */
async function rowsOwnedBy(account: { userId: string; storylineId: string }): Promise<number> {
  let total = await rowsWhere('users', 'id', account.userId);
  for (const table of await tablesWithColumn('user_id')) {
    total += await rowsWhere(table, 'user_id', account.userId);
  }
  for (const table of await tablesWithColumn('storyline_id')) {
    total += await rowsWhere(table, 'storyline_id', account.storylineId);
  }
  return total;
}

async function signedIn(
  clerkId: string,
  options: { apple?: boolean; minutesAgo?: number | null } = {}
) {
  const [user] = await db
    .select({
      id: users.id,
      clerkId: users.clerkId,
      email: users.email,
      shareUsage: users.shareUsage,
      isGuest: users.isGuest,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId));
  auth.requireCurrentUser.mockResolvedValue(user);
  auth.clerkFirstFactorAgeMinutes.mockResolvedValue(
    options.minutesAgo === undefined ? 2 : options.minutesAgo
  );
  clerk.getUser.mockResolvedValue({
    id: clerkId,
    externalAccounts: options.apple ? [{ provider: 'oauth_apple', providerUserId: APPLE_SUB }] : [],
  } as never);
}

function deleteMe(body?: unknown): Request {
  return new Request('http://api.test/api/v1/me', {
    method: 'DELETE',
    headers: {
      authorization: 'Bearer clerk-session',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cleanUp() {
  for (const clerkId of CLERK_IDS) await db.delete(users).where(eq(users.clerkId, clerkId));
}

let bystander: { userId: string; storylineId: string };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  (env as { APPLE_SIGN_IN_PRIVATE_KEY?: string }).APPLE_SIGN_IN_PRIVATE_KEY =
    await exportPKCS8(privateKey);
  applePublicKey = publicKey;
  vi.stubGlobal('fetch', fakeFetch);
  await cleanUp();
  bystander = await makeAccount('user_delete_bystander');
});

beforeEach(() => {
  calls.length = 0;
  appleTokenStatus = 200;
  clerk.deleteUser.mockReset().mockResolvedValue({} as never);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanUp();
});

describe('DELETE /api/v1/me', () => {
  it('deletes an Apple account end to end: Apple revoked, PostHog person, every row, Clerk user', async () => {
    const account = await makeAccount('user_delete_apple');
    expect(await rowsOwnedBy(account)).toBeGreaterThan(5);
    await signedIn('user_delete_apple', { apple: true, minutesAgo: 600 });

    const res = await meRoute.DELETE(deleteMe({ appleAuthorizationCode: 'fresh-apple-code' }), {});
    expect(res.status).toBe(204);

    // Apple: the code traded, then the refresh token it gave revoked.
    const [token, revoke, posthog] = calls;
    expect(token.url).toBe('https://appleid.apple.com/auth/token');
    const tokenForm = new URLSearchParams(token.body);
    expect(tokenForm.get('code')).toBe('fresh-apple-code');
    expect(tokenForm.get('grant_type')).toBe('authorization_code');
    expect(tokenForm.get('client_id')).toBe('com.brambleworld.BrambleMobile');
    const secret = await jwtVerify(tokenForm.get('client_secret')!, applePublicKey, {
      issuer: 'TEAMID1234',
      audience: 'https://appleid.apple.com',
      subject: 'com.brambleworld.BrambleMobile',
    });
    expect(secret.protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEYID12345' });

    expect(revoke.url).toBe('https://appleid.apple.com/auth/revoke');
    const revokeForm = new URLSearchParams(revoke.body);
    expect(revokeForm.get('token')).toBe('apple-refresh-token');
    expect(revokeForm.get('token_type_hint')).toBe('refresh_token');

    // PostHog: the person by their distinct id, events and all.
    expect(posthog.url).toBe('https://posthog.test/api/environments/4242/persons/bulk_delete/');
    expect(posthog.authorization).toBe('Bearer phx_test');
    expect(JSON.parse(posthog.body)).toEqual({
      distinct_ids: [account.userId],
      delete_events: true,
    });
    expect(calls).toHaveLength(3);

    expect(clerk.deleteUser).toHaveBeenCalledWith('user_delete_apple');
    expect(await rowsOwnedBy(account)).toBe(0);
    // Nobody else's data went with it.
    expect(await rowsOwnedBy(bystander)).toBeGreaterThan(5);
  });

  it('deletes an account without Apple after a recent re-verification, with no call to Apple', async () => {
    const account = await makeAccount('user_delete_email');
    await signedIn('user_delete_email', { minutesAgo: 3 });

    const res = await meRoute.DELETE(deleteMe(), {});
    expect(res.status).toBe(204);
    expect(calls.map((c) => c.url)).toEqual([
      'https://posthog.test/api/environments/4242/persons/bulk_delete/',
    ]);
    expect(clerk.deleteUser).toHaveBeenCalledWith('user_delete_email');
    expect(await rowsOwnedBy(account)).toBe(0);
  });

  describe('deletes nothing', () => {
    let account: { userId: string; storylineId: string };
    beforeAll(async () => {
      account = await makeAccount('user_delete_stale');
    });

    async function expectUntouched() {
      expect(await rowsOwnedBy(account)).toBeGreaterThan(5);
      expect(clerk.deleteUser).not.toHaveBeenCalled();
    }

    it('when the last sign-in is older than the window', async () => {
      await signedIn('user_delete_stale', { minutesAgo: 30 });
      const res = await meRoute.DELETE(deleteMe(), {});
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('REVERIFICATION_REQUIRED');
      expect(calls).toEqual([]);
      await expectUntouched();
    });

    it("when the session token doesn't say how old its sign-in is", async () => {
      await signedIn('user_delete_stale', { minutesAgo: null });
      const res = await meRoute.DELETE(deleteMe(), {});
      expect(res.status).toBe(403);
      await expectUntouched();
    });

    it('when an Apple account sends no Apple code, however recent the session', async () => {
      await signedIn('user_delete_stale', { apple: true, minutesAgo: 1 });
      const res = await meRoute.DELETE(deleteMe(), {});
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('REVERIFICATION_REQUIRED');
      expect(calls).toEqual([]);
      await expectUntouched();
    });

    it("when the Apple code is for a different Apple ID, and that ID's token is left alone", async () => {
      await signedIn('user_delete_stale', { apple: true });
      const res = await meRoute.DELETE(
        deleteMe({ appleAuthorizationCode: 'code-for-someone-else' }),
        {}
      );
      expect(res.status).toBe(403);
      expect(calls.map((c) => c.url)).toEqual(['https://appleid.apple.com/auth/token']);
      await expectUntouched();
    });

    it('when Apple refuses the code', async () => {
      await signedIn('user_delete_stale', { apple: true });
      appleTokenStatus = 400;
      const res = await meRoute.DELETE(deleteMe({ appleAuthorizationCode: 'used-code' }), {});
      expect(res.status).toBe(502);
      expect((await res.json()).error.code).toBe('APPLE_REVOCATION_FAILED');
      await expectUntouched();
    });

    it('in the database when Clerk refuses to delete the user: the rows roll back', async () => {
      await signedIn('user_delete_stale', { minutesAgo: 1 });
      clerk.deleteUser.mockRejectedValue(Object.assign(new Error('clerk down'), { status: 500 }));
      const res = await meRoute.DELETE(deleteMe(), {});
      expect(res.status).toBe(500);
      expect(clerk.deleteUser).toHaveBeenCalledOnce();
      expect(await rowsOwnedBy(account)).toBeGreaterThan(5);
    });
  });

  it('treats a Clerk user that is already gone as deleted', async () => {
    const account = await makeAccount('user_delete_gone');
    await signedIn('user_delete_gone', { minutesAgo: 1 });
    clerk.deleteUser.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const res = await meRoute.DELETE(deleteMe(), {});
    expect(res.status).toBe(204);
    expect(await rowsOwnedBy(account)).toBe(0);
  });

  it('rejects a body with anything but the Apple code', async () => {
    await signedIn('user_delete_stale', { minutesAgo: 1 });
    const res = await meRoute.DELETE(deleteMe({ password: 'nope' }), {});
    expect(res.status).toBe(400);
  });
});
