import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./users.reader', () => ({
  getUserByClerkId: vi.fn(),
  getUserByClerkIdIncludingDeleted: vi.fn(),
}));
vi.mock('./users.writer', () => ({
  insertUserIfAbsent: vi.fn(),
  updateUserByClerkId: vi.fn(),
  softDeleteUserByClerkId: vi.fn(),
}));

const reader = vi.mocked(await import('./users.reader'));
const writer = vi.mocked(await import('./users.writer'));
const { applyClerkUserEvent } = await import('./users.sync');

const row = { id: 'uuid-1', clerkId: 'user_1', email: 'a@b.com' };

// Minimal shape of the Clerk payload the mapper reads.
const userEvent = (type: string, over: Record<string, unknown> = {}) =>
  ({
    type,
    data: {
      id: 'user_1',
      primary_email_address_id: 'idn_1',
      email_addresses: [
        { id: 'idn_1', email_address: 'a@b.com', verification: { status: 'verified' } },
      ],
      ...over,
    },
  }) as never;

beforeEach(() => vi.clearAllMocks());

describe('user.created', () => {
  it('provisions the user', async () => {
    writer.insertUserIfAbsent.mockResolvedValue(row);
    await expect(applyClerkUserEvent(userEvent('user.created'))).resolves.toMatchObject({
      handled: true,
      action: 'created',
    });
  });

  it('is a no-op when lazy provisioning already created the row', async () => {
    // Redelivery, or the user already hit the API before the webhook landed.
    writer.insertUserIfAbsent.mockResolvedValue(null);
    await expect(applyClerkUserEvent(userEvent('user.created'))).resolves.toMatchObject({
      action: 'noop',
    });
  });

  it('skips an account with no email rather than failing forever', async () => {
    const event = userEvent('user.created', { email_addresses: [] });
    await expect(applyClerkUserEvent(event)).resolves.toMatchObject({ action: 'noop' });
    expect(writer.insertUserIfAbsent).not.toHaveBeenCalled();
  });

  it('records the address as unverified when Clerk says so', async () => {
    writer.insertUserIfAbsent.mockResolvedValue(row);
    await applyClerkUserEvent(
      userEvent('user.created', {
        email_addresses: [
          { id: 'idn_1', email_address: 'a@b.com', verification: { status: 'unverified' } },
        ],
      })
    );
    expect(writer.insertUserIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerifiedAt: null })
    );
  });

  it('prefers the primary address over the first one', async () => {
    writer.insertUserIfAbsent.mockResolvedValue(row);
    await applyClerkUserEvent(
      userEvent('user.created', {
        primary_email_address_id: 'idn_2',
        email_addresses: [
          { id: 'idn_1', email_address: 'first@b.com', verification: { status: 'verified' } },
          { id: 'idn_2', email_address: 'primary@b.com', verification: { status: 'verified' } },
        ],
      })
    );
    expect(writer.insertUserIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'primary@b.com' })
    );
  });
});

describe('user.updated', () => {
  it('updates the email', async () => {
    reader.getUserByClerkIdIncludingDeleted.mockResolvedValue({ ...row, deletedAt: null });
    writer.updateUserByClerkId.mockResolvedValue(row);
    await expect(applyClerkUserEvent(userEvent('user.updated'))).resolves.toMatchObject({
      action: 'updated',
    });
  });

  it('is a no-op for a user we have never seen', async () => {
    reader.getUserByClerkIdIncludingDeleted.mockResolvedValue(null);
    writer.updateUserByClerkId.mockResolvedValue(null);
    await expect(applyClerkUserEvent(userEvent('user.updated'))).resolves.toMatchObject({
      action: 'noop',
    });
  });
});

describe('user.deleted', () => {
  it('soft-deletes the user', async () => {
    writer.softDeleteUserByClerkId.mockResolvedValue(row);
    await expect(
      applyClerkUserEvent({ type: 'user.deleted', data: { id: 'user_1' } } as never)
    ).resolves.toMatchObject({ action: 'deleted' });
  });

  it('is a no-op on redelivery or an unknown user', async () => {
    writer.softDeleteUserByClerkId.mockResolvedValue(null);
    await expect(
      applyClerkUserEvent({ type: 'user.deleted', data: { id: 'user_1' } } as never)
    ).resolves.toMatchObject({ action: 'noop' });
  });

  it('tolerates a payload with no id', async () => {
    await expect(
      applyClerkUserEvent({ type: 'user.deleted', data: {} } as never)
    ).resolves.toMatchObject({ action: 'noop' });
    expect(writer.softDeleteUserByClerkId).not.toHaveBeenCalled();
  });
});

describe('unhandled events', () => {
  it('reports them as unhandled without touching the database', async () => {
    await expect(
      applyClerkUserEvent({ type: 'session.created', data: { id: 'sess_1' } } as never)
    ).resolves.toEqual({ handled: false, event: 'session.created' });
    expect(writer.insertUserIfAbsent).not.toHaveBeenCalled();
    expect(writer.updateUserByClerkId).not.toHaveBeenCalled();
    expect(writer.softDeleteUserByClerkId).not.toHaveBeenCalled();
  });
});
