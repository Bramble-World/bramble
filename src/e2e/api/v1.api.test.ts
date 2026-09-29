import { expect, test } from '@playwright/test';

/**
 * Every `/api/v1` path, unauthenticated.
 *
 * Table-driven because the surface is growing — three routes became ten in one
 * PR — and the thing being protected is a configuration file, not a handler:
 * `proxy.ts` deliberately excludes `/api` from its matcher, and a well-meant
 * change to that matcher would turn a bearer client's JSON 401 into a 3xx
 * handshake with a sign-in page. Nothing in the type system notices.
 *
 * Credential-free on purpose: CI runs the dev server with no secrets at all, so
 * Clerk is unconfigured there, and every case below must answer identically
 * whether it is configured or not.
 *
 * The uuid is real but arbitrary. Authentication is checked before ownership, so
 * an unauthenticated request must never get far enough to learn whether the id
 * exists — a 404 here would itself be the leak.
 */
const ID = '00000000-0000-4000-8000-000000000000';

const PATHS: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: '/api/v1/world' },
  { method: 'GET', path: `/api/v1/people/${ID}` },
  { method: 'GET', path: `/api/v1/storylines/${ID}` },
  { method: 'POST', path: `/api/v1/storylines/${ID}/sessions` },
  { method: 'GET', path: `/api/v1/sessions/${ID}` },
  { method: 'POST', path: `/api/v1/sessions/${ID}/answer` },
  { method: 'POST', path: `/api/v1/sessions/${ID}/turn` },
];

const UNAUTHORIZED = { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } };

for (const { method, path } of PATHS) {
  test(`${method} ${path} rejects an anonymous request with 401 JSON`, async ({ request }) => {
    const res = await request.fetch(path, { method, data: method === 'POST' ? {} : undefined });

    expect(res.status()).toBe(401);
    expect(res.headers()['content-type']).toContain('application/json');
    await expect(res.json()).resolves.toEqual(UNAUTHORIZED);
  });

  test(`${method} ${path} answers with 401, never a redirect`, async ({ request }) => {
    const res = await request.fetch(path, {
      method,
      data: method === 'POST' ? {} : undefined,
      maxRedirects: 0,
    });

    expect(res.status()).toBe(401);
  });

  test(`${method} ${path} rejects a forged bearer token`, async ({ request }) => {
    const res = await request.fetch(path, {
      method,
      data: method === 'POST' ? {} : undefined,
      // Structurally a JWT, alg:none — the security-relevant shape.
      headers: {
        Authorization: 'Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyXzEyMyJ9.',
      },
    });

    expect(res.status()).toBe(401);
    await expect(res.json()).resolves.toEqual(UNAUTHORIZED);
  });
}

/**
 * A malformed id must not be the thing that answers first. Validation before
 * authentication would tell an anonymous caller which of its ids were the wrong
 * shape — small, but it is a signal it should not have at all.
 */
test('a malformed id still answers 401, not 400', async ({ request }) => {
  const res = await request.get('/api/v1/people/not-a-uuid');
  expect(res.status()).toBe(401);
});

test('every v1 rejection is byte-identical, so nothing acts as an oracle', async ({ request }) => {
  const bodies = await Promise.all(
    PATHS.map(({ method, path }) =>
      request
        .fetch(path, { method, data: method === 'POST' ? {} : undefined })
        .then((r) => r.text())
    )
  );

  expect(new Set(bodies).size).toBe(1);
});
