import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  // A plain object, so a test can set the token and clear it again.
  return { env: { ...actual.env } };
});

const { env } = await import('@/env');
const { GET } = await import('./route');

describe('/.well-known/openai-apps-challenge', () => {
  afterEach(() => {
    (env as { OPENAI_APPS_CHALLENGE?: string }).OPENAI_APPS_CHALLENGE = undefined;
  });

  it('serves the token as plain text', async () => {
    (env as { OPENAI_APPS_CHALLENGE?: string }).OPENAI_APPS_CHALLENGE = 'challenge-token-123';
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('challenge-token-123');
  });

  it('is a 404 until the token is set', () => {
    expect(GET().status).toBe(404);
  });
});
