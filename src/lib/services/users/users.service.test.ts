import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError } from '@/lib/utils/errors';

vi.mock('./users.reader', () => ({
  getUserByClerkId: vi.fn(),
  getUserByClerkIdIncludingDeleted: vi.fn(),
}));
vi.mock('./users.writer', () => ({ insertUserIfAbsent: vi.fn() }));

const reader = vi.mocked(await import('./users.reader'));
const writer = vi.mocked(await import('./users.writer'));
const { getOrCreateFromClerk } = await import('./users.service');

const row = { id: 'uuid-1', clerkId: 'user_123', email: 'a@b.com' };
const identity = async () => ({ email: 'A@B.com', emailVerified: true });

beforeEach(() => vi.clearAllMocks());

describe('getOrCreateFromClerk', () => {
  it('returns the existing row without inserting or calling Clerk', async () => {
    reader.getUserByClerkId.mockResolvedValue(row);
    const fetchIdentity = vi.fn(identity);

    await expect(getOrCreateFromClerk('user_123', fetchIdentity)).resolves.toEqual(row);
    expect(fetchIdentity).not.toHaveBeenCalled();
    expect(writer.insertUserIfAbsent).not.toHaveBeenCalled();
  });

  it('provisions on first sight, lowercasing the email', async () => {
    reader.getUserByClerkId.mockResolvedValue(null);
    writer.insertUserIfAbsent.mockResolvedValue(row);

    await expect(getOrCreateFromClerk('user_123', identity)).resolves.toEqual(row);
    expect(writer.insertUserIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ clerkId: 'user_123', email: 'a@b.com' })
    );
  });

  it('records emailVerifiedAt only when Clerk reports the address verified', async () => {
    reader.getUserByClerkId.mockResolvedValue(null);
    writer.insertUserIfAbsent.mockResolvedValue(row);

    await getOrCreateFromClerk('user_123', async () => ({
      email: 'a@b.com',
      emailVerified: false,
    }));
    expect(writer.insertUserIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerifiedAt: null })
    );
  });

  it('returns the winner row when a concurrent request provisioned first', async () => {
    // Insert reports a conflict, then the re-read finds the other request's row.
    reader.getUserByClerkId.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    writer.insertUserIfAbsent.mockResolvedValue(null);

    await expect(getOrCreateFromClerk('user_123', identity)).resolves.toEqual(row);
  });

  it('rejects a soft-deleted account with 403 rather than looping', async () => {
    reader.getUserByClerkId.mockResolvedValue(null);
    writer.insertUserIfAbsent.mockResolvedValue(null);
    reader.getUserByClerkIdIncludingDeleted.mockResolvedValue({ ...row, deletedAt: new Date() });

    await expect(getOrCreateFromClerk('user_123', identity)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reports an email owned by a different clerk id as 409, not a raw 500', async () => {
    reader.getUserByClerkId.mockResolvedValue(null);
    writer.insertUserIfAbsent.mockResolvedValue(null);
    reader.getUserByClerkIdIncludingDeleted.mockResolvedValue(null);

    const error = await getOrCreateFromClerk('user_123', identity).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).statusCode).toBe(409);
  });
});
