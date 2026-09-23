import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';

vi.mock('./persons.reader', () => ({
  getSelfPerson: vi.fn(),
  getPersonByContactRef: vi.fn(),
  getPerson: vi.fn(),
  ownedPersonIds: vi.fn(),
  listPersons: vi.fn(),
}));
vi.mock('./persons.writer', () => ({
  insertPersonIfAbsent: vi.fn(),
  insertPersonRelationshipIfAbsent: vi.fn(),
}));

const reader = vi.mocked(await import('./persons.reader'));
const writer = vi.mocked(await import('./persons.writer'));
const service = await import('./persons.service');

const USER = 'user-1';
const blossom = { id: 'p-self', name: 'Blossom', isSelf: true, voiceProfile: null };

beforeEach(() => vi.clearAllMocks());

describe('getOrCreateSelfPerson', () => {
  it('returns the existing row without inserting', async () => {
    reader.getSelfPerson.mockResolvedValue(blossom);

    await expect(service.getOrCreateSelfPerson(USER, 'Blossom')).resolves.toBe(blossom);
    expect(writer.insertPersonIfAbsent).not.toHaveBeenCalled();
  });

  it('creates the account holder as a person on first sight', async () => {
    reader.getSelfPerson.mockResolvedValue(null);
    writer.insertPersonIfAbsent.mockResolvedValue(blossom);

    await expect(service.getOrCreateSelfPerson(USER, 'Blossom')).resolves.toBe(blossom);
    expect(writer.insertPersonIfAbsent).toHaveBeenCalledWith({
      userId: USER,
      name: 'Blossom',
      isSelf: true,
    });
  });

  // The partial unique index (WHERE is_self = true) arbitrates, not the
  // application: the loser of the race gets zero rows back and re-reads the
  // winner's row rather than retrying or locking.
  it('re-reads the winner when a concurrent request created it first', async () => {
    reader.getSelfPerson.mockResolvedValueOnce(null).mockResolvedValueOnce(blossom);
    writer.insertPersonIfAbsent.mockResolvedValue(null);

    await expect(service.getOrCreateSelfPerson(USER, 'Blossom')).resolves.toBe(blossom);
  });
});

describe('getOrCreatePersonByHandle', () => {
  const maya = { id: 'p-maya', name: 'Maya', isSelf: false, voiceProfile: null };

  // The raw handle must never reach the column. Both the lookup and the insert
  // have to use the same hash, or the same contact gets a second persons row.
  it('looks up and writes under the same hashed ref, never the raw handle', async () => {
    reader.getPersonByContactRef.mockResolvedValue(null);
    writer.insertPersonIfAbsent.mockResolvedValue(maya);

    await service.getOrCreatePersonByHandle(USER, '+1 (555) 010-9999', 'Maya');

    const lookedUpWith = reader.getPersonByContactRef.mock.calls[0][1];
    const writtenWith = writer.insertPersonIfAbsent.mock.calls[0][0].sourceContactRef;

    expect(writtenWith).toBe(lookedUpWith);
    expect(writtenWith).toMatch(/^[0-9a-f]{64}$/);
    expect(writtenWith).not.toContain('555');
  });

  it('reuses the existing person rather than creating a duplicate', async () => {
    reader.getPersonByContactRef.mockResolvedValue(maya);

    await expect(service.getOrCreatePersonByHandle(USER, '5550109999', 'Maya')).resolves.toBe(maya);
    expect(writer.insertPersonIfAbsent).not.toHaveBeenCalled();
  });
});

describe('linkPersons', () => {
  const owned = (...ids: string[]) => reader.ownedPersonIds.mockResolvedValue(new Set(ids));

  // personRelationships carries CHECK (person_a_id < person_b_id), so the same
  // pair cannot be stored twice reversed. The sort has to happen before the
  // write regardless of which order the caller supplied.
  it.each([
    ['aaa', 'zzz'],
    ['zzz', 'aaa'],
  ])('sorts the pair before writing, given (%s, %s)', async (one, two) => {
    owned('aaa', 'zzz');
    writer.insertPersonRelationshipIfAbsent.mockResolvedValue({ id: 'rel-1' });

    await service.linkPersons(USER, one, two, 'siblings');

    expect(writer.insertPersonRelationshipIfAbsent).toHaveBeenCalledWith({
      userId: USER,
      personAId: 'aaa',
      personBId: 'zzz',
      relationshipType: 'siblings',
    });
  });

  // invariants.md §3: "a relationship joining two users' contacts". No foreign
  // key checks this — personRelationships has single-column FKs to persons and a
  // userId of its own, and nothing relates them.
  it('refuses to relate a person the caller does not own', async () => {
    owned('aaa'); // only one of the two came back

    await expect(service.linkPersons(USER, 'aaa', 'someone-elses')).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(writer.insertPersonRelationshipIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects relating a person to themselves before touching the database', async () => {
    await expect(service.linkPersons(USER, 'aaa', 'aaa')).rejects.toBeInstanceOf(ValidationError);
    expect(reader.ownedPersonIds).not.toHaveBeenCalled();
  });

  it('reports an already-recorded pair as a conflict', async () => {
    owned('aaa', 'zzz');
    writer.insertPersonRelationshipIfAbsent.mockResolvedValue(null);

    await expect(service.linkPersons(USER, 'aaa', 'zzz')).rejects.toBeInstanceOf(ConflictError);
  });
});
