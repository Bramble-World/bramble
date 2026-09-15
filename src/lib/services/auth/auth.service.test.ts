import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@/lib/utils/errors';

// Mocked so this suite never reaches Clerk, pg, or drizzle.
vi.mock('./auth.client', () => ({
  clerkBackend: { authenticateRequest: vi.fn(), users: { getUser: vi.fn() } },
}));
vi.mock('./auth.config', () => ({ clerkEnabled: true }));
vi.mock('@/lib/services/users/users.service', () => ({ getOrCreateFromClerk: vi.fn() }));

const { clerkBackend } = await import('./auth.client');
const { requireClerkUserId } = await import('./auth.service');
const authenticateRequest = vi.mocked(clerkBackend.authenticateRequest);

const req = (headers?: Record<string, string>) =>
  new Request('http://localhost/api/me', { headers });

const signedIn = (userId: string) =>
  ({ isAuthenticated: true, toAuth: () => ({ userId }) }) as never;
const signedOut = { isAuthenticated: false } as never;

beforeEach(() => vi.clearAllMocks());

describe('requireClerkUserId', () => {
  it('returns the Clerk user id for a valid bearer token', async () => {
    authenticateRequest.mockResolvedValue(signedIn('user_123'));
    await expect(requireClerkUserId(req({ authorization: 'Bearer good' }))).resolves.toBe(
      'user_123'
    );
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty header', { authorization: '' }],
    ['the wrong scheme', { authorization: 'Basic abc123' }],
    ['a scheme with no token', { authorization: 'Bearer' }],
    ['lowercase bearer', { authorization: 'bearer good' }],
  ])('rejects %s without calling Clerk', async (_label, headers) => {
    await expect(requireClerkUserId(req(headers))).rejects.toBeInstanceOf(UnauthorizedError);
    // The short-circuit matters: it is what keeps an unauthenticated request
    // from touching the network or the database.
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  it('rejects when Clerk reports the request is not authenticated', async () => {
    authenticateRequest.mockResolvedValue(signedOut);
    await expect(requireClerkUserId(req({ authorization: 'Bearer bad' }))).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('never leaks the Clerk failure reason to the caller', async () => {
    authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'session-token-expired',
    } as never);
    // Differentiating failure reasons would hand an attacker an oracle and
    // buys a client nothing — it refreshes on any 401.
    await expect(requireClerkUserId(req({ authorization: 'Bearer expired' }))).rejects.toThrowError(
      'Unauthorized'
    );
  });
});

describe('requireClerkUserId when Clerk is not configured', () => {
  it('answers 401 rather than letting Clerk throw a raw 500', async () => {
    vi.resetModules();
    vi.doMock('./auth.config', () => ({ clerkEnabled: false }));
    const { requireClerkUserId: unconfigured } = await import('./auth.service');
    // resetModules gives the re-imported service a fresh errors module, so the
    // class identity differs from the one imported at the top of this file.
    const { UnauthorizedError: FreshUnauthorized } = await import('@/lib/utils/errors');

    const error = await unconfigured(req({ authorization: 'Bearer anything' })).catch((e) => e);
    expect(error).toBeInstanceOf(FreshUnauthorized);
    expect((error as UnauthorizedError).statusCode).toBe(401);
    expect((error as UnauthorizedError).code).toBe('UNAUTHORIZED');
  });
});
