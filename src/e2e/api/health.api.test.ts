import { expect, test } from '@playwright/test';

// Browserless: the `request` fixture speaks HTTP directly, so this project
// needs no browser binary at all.

test('GET /api/health returns ok', async ({ request }) => {
  const res = await request.get('/api/health');

  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  await expect(res.json()).resolves.toEqual({ status: 'ok' });
});

test('an unknown API path is not served as JSON success', async ({ request }) => {
  const res = await request.get('/api/does-not-exist');
  expect(res.ok()).toBe(false);
  expect(res.status()).toBe(404);
});
