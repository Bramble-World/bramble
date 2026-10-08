import { expect, test } from '@playwright/test';

// Browserless, and deliberately credential-free: CI runs the dev server with no
// secrets, so Clerk is unconfigured there. Every case below must answer 401
// identically whether Clerk is configured or not — which is exactly the
// property worth pinning.

const REJECTED: Record<string, Record<string, string> | undefined> = {
  'no Authorization header': undefined,
  'an empty header': { Authorization: '' },
  'the wrong scheme': { Authorization: 'Basic YWJjOjEyMw==' },
  'a scheme with no token': { Authorization: 'Bearer' },
  'a malformed token': { Authorization: 'Bearer not-a-jwt' },
  'a two-segment token': { Authorization: 'Bearer aaa.bbb' },
  // Structurally a JWT, but alg:none — the security-relevant one.
  'an alg:none token': {
    Authorization: 'Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyXzEyMyJ9.',
  },
};

for (const [label, headers] of Object.entries(REJECTED)) {
  test(`GET /api/me rejects ${label} with 401 JSON`, async ({ request }) => {
    const res = await request.get('/api/me', { headers });

    expect(res.status()).toBe(401);
    expect(res.headers()['content-type']).toContain('application/json');
    await expect(res.json()).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });
}

test('every rejection is byte-identical, so nothing acts as an oracle', async ({ request }) => {
  const bodies = await Promise.all(
    Object.values(REJECTED).map((headers) =>
      request.get('/api/me', { headers }).then((r) => r.text())
    )
  );
  expect(new Set(bodies).size).toBe(1);
});

test('a rejection leaks no internals', async ({ request }) => {
  const body = await request.get('/api/me').then((r) => r.text());
  for (const leak of ['token-', 'at Object.', 'CLERK_', 'sk_', 'Error:']) {
    expect(body).not.toContain(leak);
  }
});

test('the API answers with 401, never a redirect to a sign-in page', async ({ request }) => {
  // Guards the proxy matcher: if /api were proxied, Clerk could hand a bearer
  // client a 3xx handshake where it expects JSON.
  const res = await request.get('/api/me', { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});
