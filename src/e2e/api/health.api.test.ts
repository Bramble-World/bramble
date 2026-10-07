import { expect, test } from '@playwright/test';

// Browserless: the `request` fixture speaks HTTP directly, so this project
// needs no browser binary at all.

test('GET /api/health returns ok', async ({ request }) => {
  const res = await request.get('/api/health');

  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  await expect(res.json()).resolves.toEqual({ status: 'ok' });
});

/**
 * Readiness over HTTP, which is the only way to check the thing that matters: it
 * must not need a bearer token. A probe is an unauthenticated GET from a load
 * balancer, and an endpoint that answers 401 to one is no use at all.
 *
 * Both outcomes are accepted, deliberately. CI runs with no secrets, so Postgres
 * and Redis are genuinely absent there and 503 is the correct answer; locally
 * Doppler supplies both and it is 200. Pinning one would mean a test that only
 * passes in one of the two places it runs. What is asserted instead holds in
 * both: the status matches the body, the probe names only check names, and
 * nothing in it is behind auth.
 */
test('GET /api/ready answers without auth and never leaks a connection string', async ({
  request,
}) => {
  const res = await request.get('/api/ready');

  expect([200, 503]).toContain(res.status());
  const body = await res.json();

  if (res.status() === 200) {
    expect(body).toEqual({ status: 'ok' });
  } else {
    expect(body.status).toBe('unavailable');
    // Check names only — never the error, which carries credentials.
    expect(body.failed.length).toBeGreaterThan(0);
    for (const name of body.failed) expect(['postgres', 'redis']).toContain(name);
  }
});

/**
 * Liveness must not depend on anything outside the process. Asserted next to the
 * readiness test because the pair is the point: wiring a dependency check to
 * liveness restarts every replica the moment Postgres blips.
 */
test('GET /api/health stays 200 regardless of what /api/ready says', async ({ request }) => {
  const [health, ready] = await Promise.all([
    request.get('/api/health'),
    request.get('/api/ready'),
  ]);

  expect(health.status()).toBe(200);
  // Meaningful in CI, where readiness really is 503: liveness is still 200.
  expect([200, 503]).toContain(ready.status());
});

test('an unknown API path is not served as JSON success', async ({ request }) => {
  const res = await request.get('/api/does-not-exist');
  expect(res.ok()).toBe(false);
  expect(res.status()).toBe(404);
});
