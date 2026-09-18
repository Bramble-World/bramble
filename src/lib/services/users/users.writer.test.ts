import { describe, expect, it, vi } from 'vitest';

// The writer is the single place email case is normalised, so this pins it at
// the boundary rather than at each call site. A regression here would let the
// case-sensitive partial unique index admit two rows for one address.
const values = vi.fn().mockReturnThis();
const returning = vi.fn().mockResolvedValue([{ id: 'u1', clerkId: 'c1', email: 'a@b.com' }]);

vi.mock('@/index', () => ({
  db: {
    insert: () => ({ values, onConflictDoNothing: () => ({ returning }) }),
    update: () => ({ set: values, where: () => ({ returning }) }),
  },
}));
vi.mock('@/db/schema/tables', () => ({ users: {} }));

const writer = await import('./users.writer');

describe('email normalisation', () => {
  it('lowercases on insert', async () => {
    await writer.insertUserIfAbsent({ clerkId: 'c1', email: 'MiXeD@Example.COM' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ email: 'mixed@example.com' }));
  });

  it('lowercases on update', async () => {
    await writer.updateUserByClerkId('c1', { email: 'NEW@Example.com' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com' }));
  });

  it('does not write anything for an empty patch', async () => {
    await expect(writer.updateUserByClerkId('c1', {})).resolves.toBeNull();
  });
});
