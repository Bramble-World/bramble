import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@/lib/utils/errors';
import type { InviteView } from '@/lib/services/invites/invites.service';
import { resolveInvite } from './resolve';

const open: InviteView = {
  inviterFirstName: 'Maya',
  expiresAt: new Date('2026-12-03'),
  state: 'open',
};

describe('resolveInvite', () => {
  it('reads a code in its one spelling', async () => {
    const read = vi.fn(async () => open);
    expect(await resolveInvite('ABCDEF', read)).toEqual({
      kind: 'invite',
      code: 'ABCDEF',
      invite: open,
    });
    expect(read).toHaveBeenCalledWith('ABCDEF');
  });

  it('sends any other spelling to it, without a lookup', async () => {
    const read = vi.fn(async () => open);
    expect(await resolveInvite('abcdef', read)).toEqual({ kind: 'redirect', code: 'ABCDEF' });
    expect(await resolveInvite('ABC%20DEF', read)).toEqual({ kind: 'redirect', code: 'ABCDEF' });
    expect(read).not.toHaveBeenCalled();
  });

  it('is missing for something that can’t be a code, without a lookup', async () => {
    const read = vi.fn(async () => open);
    for (const raw of ['ABC', 'ABCDEFG', 'ABCDE1', 'ABCDEI', '']) {
      expect(await resolveInvite(raw, read)).toEqual({ kind: 'missing' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('is missing for a code nobody made', async () => {
    const read = vi.fn(async () => {
      throw new NotFoundError('Invite');
    });
    expect(await resolveInvite('ABCDEF', read)).toEqual({ kind: 'missing' });
  });

  it('lets anything else go up, so it is a 500 and not a quiet 404', async () => {
    await expect(
      resolveInvite('ABCDEF', async () => Promise.reject(new Error('db down')))
    ).rejects.toThrow('db down');
  });
});
