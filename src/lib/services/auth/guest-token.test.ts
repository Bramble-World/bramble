// @vitest-environment node
// jose checks `instanceof Uint8Array`, which jsdom's realm fails for buffers
// Node creates; the token code only ever runs on the server anyway.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, UnsecuredJWT } from 'jose';
import { UnauthorizedError } from '@/lib/utils/errors';

vi.mock('./auth.client', () => ({
  clerkBackend: { authenticateRequest: vi.fn(), users: { getUser: vi.fn() } },
}));
vi.mock('./auth.config', () => ({ clerkEnabled: true }));
vi.mock('@/lib/services/users/users.service', () => ({
  getOrCreateFromClerk: vi.fn(),
  requireLiveGuest: vi.fn(),
}));

const { GUEST_TOKEN_ISSUER, isGuestToken, signGuestToken, verifyGuestToken } =
  await import('./guest-token');
const { requireCurrentUser } = await import('./auth.service');
const { clerkBackend } = await import('./auth.client');
const usersService = vi.mocked(await import('@/lib/services/users/users.service'));

const SECRET = new TextEncoder().encode('unit-test-guest-token-secret-32-chars!');
const USER_ID = '4f1d0c3e-7b2a-4c9e-9f10-2a6b8d5e1c33';
const inAWeek = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

/** A token built by hand, for the cases signGuestToken would never produce. */
function forge(
  claims: { iss?: string; sub?: string; exp?: number },
  key: Uint8Array = SECRET
): Promise<string> {
  const jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
  if (claims.iss) jwt.setIssuer(claims.iss);
  if (claims.sub) jwt.setSubject(claims.sub);
  if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);
  return jwt.sign(key);
}

beforeEach(() => vi.clearAllMocks());

describe('guest tokens', () => {
  it('round-trips the user id', async () => {
    const token = await signGuestToken(USER_ID, inAWeek());
    expect(isGuestToken(token)).toBe(true);
    await expect(verifyGuestToken(token)).resolves.toBe(USER_ID);
  });

  it('expires when the guest does', async () => {
    const expiresAt = inAWeek();
    const token = await signGuestToken(USER_ID, expiresAt);
    const [, payload] = token.split('.');
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(exp).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  it('refuses an expired token', async () => {
    const token = await forge({
      iss: GUEST_TOKEN_ISSUER,
      sub: USER_ID,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(verifyGuestToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a token from another issuer, even signed with the right key', async () => {
    const token = await forge({ iss: 'https://clerk.example.com', sub: USER_ID, exp: 2e9 });
    expect(isGuestToken(token)).toBe(false);
    await expect(verifyGuestToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a tampered payload', async () => {
    const token = await signGuestToken(USER_ID, inAWeek());
    const [header, , signature] = token.split('.');
    const other = Buffer.from(
      JSON.stringify({
        iss: GUEST_TOKEN_ISSUER,
        sub: '00000000-0000-4000-8000-000000000000',
        exp: 2e9,
      })
    ).toString('base64url');
    await expect(verifyGuestToken(`${header}.${other}.${signature}`)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('refuses a token signed with a different key', async () => {
    const token = await forge(
      { iss: GUEST_TOKEN_ISSUER, sub: USER_ID, exp: 2e9 },
      new TextEncoder().encode('a-different-secret-that-is-32-chars-long')
    );
    await expect(verifyGuestToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses alg:none, even claiming our issuer', async () => {
    const token = new UnsecuredJWT({})
      .setIssuer(GUEST_TOKEN_ISSUER)
      .setSubject(USER_ID)
      .setExpirationTime(2e9)
      .encode();
    expect(isGuestToken(token)).toBe(true);
    await expect(verifyGuestToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a subject that is not a uuid', async () => {
    const token = await forge({ iss: GUEST_TOKEN_ISSUER, sub: "1' or 1=1", exp: 2e9 });
    await expect(verifyGuestToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('does not mistake garbage for a guest token', () => {
    for (const token of ['not-a-jwt', 'aaa.bbb', '', 'a.b.c']) {
      expect(isGuestToken(token)).toBe(false);
    }
  });

  it('fails closed with no secret configured', async () => {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { GUEST_TOKEN_SECRET: undefined } }));
    const unconfigured = await import('./guest-token');
    const { UnauthorizedError: Fresh, InternalServerError } = await import('@/lib/utils/errors');

    await expect(unconfigured.signGuestToken(USER_ID, inAWeek())).rejects.toBeInstanceOf(
      InternalServerError
    );
    const token = await signGuestToken(USER_ID, inAWeek());
    await expect(unconfigured.verifyGuestToken(token)).rejects.toBeInstanceOf(Fresh);
    vi.doUnmock('@/env');
  });
});

describe('requireCurrentUser dispatches on the issuer', () => {
  const req = (token: string) =>
    new Request('http://localhost/api/me', { headers: { authorization: `Bearer ${token}` } });

  it('sends a guest token to the guest path, never to Clerk', async () => {
    const guest = { id: USER_ID, clerkId: null, email: null, shareUsage: true, isGuest: true };
    usersService.requireLiveGuest.mockResolvedValue(guest);

    await expect(requireCurrentUser(req(await signGuestToken(USER_ID, inAWeek())))).resolves.toBe(
      guest
    );
    expect(usersService.requireLiveGuest).toHaveBeenCalledWith(USER_ID);
    expect(clerkBackend.authenticateRequest).not.toHaveBeenCalled();
  });

  it('answers a forged guest token with the same bare 401, without reading the row', async () => {
    const forged = await forge(
      { iss: GUEST_TOKEN_ISSUER, sub: USER_ID, exp: 2e9 },
      new TextEncoder().encode('a-different-secret-that-is-32-chars-long')
    );
    const error = await requireCurrentUser(req(forged)).catch((e) => e);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.message).toBe('Unauthorized');
    expect(usersService.requireLiveGuest).not.toHaveBeenCalled();
    expect(clerkBackend.authenticateRequest).not.toHaveBeenCalled();
  });

  it('sends anything else to Clerk, exactly as before', async () => {
    vi.mocked(clerkBackend.authenticateRequest).mockResolvedValue({
      isAuthenticated: false,
    } as never);
    const alg = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyXzEyMyJ9.';
    for (const token of ['not-a-jwt', alg]) {
      await expect(requireCurrentUser(req(token))).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(clerkBackend.authenticateRequest).toHaveBeenCalledTimes(2);
    expect(usersService.requireLiveGuest).not.toHaveBeenCalled();
  });
});
