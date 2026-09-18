import { expect, test } from '@playwright/test';

// Credential-free, like the rest of the api project. With no signing secret
// configured (CI's state) the route must reject everything — a closed default.
// With a secret configured, an unsigned request must still be rejected. Both
// paths answer 401, so these assertions hold either way.

const payload = { type: 'user.deleted', data: { id: 'user_attacker' } };

test('an unsigned webhook is rejected', async ({ request }) => {
  const res = await request.post('/api/webhooks/clerk', { data: payload });
  expect(res.status()).toBe(401);
  await expect(res.json()).resolves.toEqual({
    error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
  });
});

test('forged svix headers are rejected', async ({ request }) => {
  const res = await request.post('/api/webhooks/clerk', {
    headers: {
      'svix-id': 'msg_forged',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=',
    },
    data: payload,
  });
  expect(res.status()).toBe(401);
});

test('the webhook is not reachable with a bearer token instead of a signature', async ({
  request,
}) => {
  // Trust must come from the signature, never from user auth.
  const res = await request.post('/api/webhooks/clerk', {
    headers: { Authorization: 'Bearer anything' },
    data: payload,
  });
  expect(res.status()).toBe(401);
});

test('GET is not allowed', async ({ request }) => {
  const res = await request.get('/api/webhooks/clerk');
  expect(res.status()).toBe(405);
});
