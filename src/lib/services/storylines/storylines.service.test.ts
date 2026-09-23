import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '@/lib/utils/errors';

vi.mock('./storylines.reader', () => ({
  getStoryline: vi.fn(),
  listStorylines: vi.fn(),
  listCharacters: vi.fn(),
  ownedStorylineIds: vi.fn(),
  charactersInStoryline: vi.fn(),
}));
vi.mock('./storylines.writer', () => ({
  insertStoryline: vi.fn(),
  setStorylineStatus: vi.fn(),
  insertCharacterIfAbsent: vi.fn(),
  insertCharacterRelationshipIfAbsent: vi.fn(),
  insertStorylineLinkIfAbsent: vi.fn(),
}));
vi.mock('../persons/persons.reader', () => ({ getPerson: vi.fn() }));

const reader = vi.mocked(await import('./storylines.reader'));
const writer = vi.mocked(await import('./storylines.writer'));
const personReader = vi.mocked(await import('../persons/persons.reader'));
const service = await import('./storylines.service');

const USER = 'user-1';
const STORY = 'story-1';
const storyline = {
  id: STORY,
  title: 'The Unsent Apology',
  sourceSurface: 'imessage',
  setting: null,
  tone: null,
  status: 'ready' as const,
  failureReason: null,
  arcSummary: null,
  arcSummaryGeneratedAt: null,
};

beforeEach(() => vi.clearAllMocks());

describe('status and failureReason', () => {
  // invariants.md §4: failureReason must be set exactly when status is 'failed'
  // and null otherwise, and nothing in the database ties them together.
  it('cannot reach the failed state without a reason', async () => {
    await expect(service.markFailed(USER, STORY, '   ')).rejects.toBeInstanceOf(ValidationError);
    expect(writer.setStorylineStatus).not.toHaveBeenCalled();
  });

  it('writes the status and the reason together', async () => {
    writer.setStorylineStatus.mockResolvedValue({
      ...storyline,
      status: 'failed',
      failureReason: 'model timed out',
    });

    await service.markFailed(USER, STORY, 'model timed out');

    expect(writer.setStorylineStatus).toHaveBeenCalledWith(
      USER,
      STORY,
      'failed',
      'model timed out'
    );
  });

  it('is scoped to the caller, so another user cannot fail your storyline', async () => {
    writer.setStorylineStatus.mockResolvedValue(null);

    await expect(service.markFailed(USER, STORY, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('castCharacter', () => {
  const person = { id: 'p-maya', name: 'Maya', isSelf: false, voiceProfile: null };
  const character = {
    id: 'c-1',
    storylineId: STORY,
    personId: 'p-maya',
    role: 'supporting' as const,
    description: null,
    voiceProfileOverride: null,
  };

  // invariants.md §3: "a storyline cast with another user's person". characters
  // has independent single-column FKs to storylines and persons, so nothing
  // checks that the two share an owner.
  it('refuses a person the caller does not own', async () => {
    reader.getStoryline.mockResolvedValue(storyline);
    personReader.getPerson.mockResolvedValue(null);

    await expect(service.castCharacter(USER, STORY, 'someone-elses-person')).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(writer.insertCharacterIfAbsent).not.toHaveBeenCalled();
  });

  it('refuses a storyline the caller does not own', async () => {
    reader.getStoryline.mockResolvedValue(null);

    await expect(
      service.castCharacter(USER, 'someone-elses-story', 'p-maya')
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(personReader.getPerson).not.toHaveBeenCalled();
  });

  it('casts when both belong to the caller', async () => {
    reader.getStoryline.mockResolvedValue(storyline);
    personReader.getPerson.mockResolvedValue(person);
    writer.insertCharacterIfAbsent.mockResolvedValue(character);

    await expect(service.castCharacter(USER, STORY, 'p-maya')).resolves.toBe(character);
  });

  // Re-casting is a retry, not an error: the unique index makes the insert a
  // no-op and the existing casting is what the caller wanted anyway.
  it('returns the existing casting rather than failing', async () => {
    reader.getStoryline.mockResolvedValue(storyline);
    personReader.getPerson.mockResolvedValue(person);
    writer.insertCharacterIfAbsent.mockResolvedValue(null);
    reader.listCharacters.mockResolvedValue([character]);

    await expect(service.castCharacter(USER, STORY, 'p-maya')).resolves.toBe(character);
  });
});

describe('relateCharacters', () => {
  beforeEach(() => reader.getStoryline.mockResolvedValue(storyline));

  it.each([
    ['aaa', 'zzz'],
    ['zzz', 'aaa'],
  ])('sorts the pair before writing, given (%s, %s)', async (one, two) => {
    reader.charactersInStoryline.mockResolvedValue(new Set(['aaa', 'zzz']));
    writer.insertCharacterRelationshipIfAbsent.mockResolvedValue({ id: 'rel-1' });

    await service.relateCharacters(USER, STORY, one, two);

    expect(writer.insertCharacterRelationshipIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ characterAId: 'aaa', characterBId: 'zzz' })
    );
  });

  // invariants.md §3: "a relationship spanning two storylines". The row carries
  // its own storylineId and two character ids, and no foreign key relates them.
  it('refuses a character from another storyline', async () => {
    reader.charactersInStoryline.mockResolvedValue(new Set(['aaa'])); // only one is in this story

    await expect(
      service.relateCharacters(USER, STORY, 'aaa', 'from-another-story')
    ).rejects.toBeInstanceOf(ValidationError);
    expect(writer.insertCharacterRelationshipIfAbsent).not.toHaveBeenCalled();
  });
});

describe('linkStorylines', () => {
  beforeEach(() => {
    reader.ownedStorylineIds.mockResolvedValue(new Set(['zzz-story', 'aaa-story']));
    writer.insertStorylineLinkIfAbsent.mockResolvedValue({ id: 'link-1' });
  });

  // sequel and spinoff are directional: A precedes B, and swapping them says
  // something different. The ids must survive in the order given.
  it.each(['sequel', 'spinoff'] as const)('preserves direction for %s', async (linkType) => {
    await service.linkStorylines(USER, 'zzz-story', 'aaa-story', linkType);

    expect(writer.insertStorylineLinkIfAbsent).toHaveBeenCalledWith({
      storylineAId: 'zzz-story',
      storylineBId: 'aaa-story',
      linkType,
    });
  });

  // parallel and crossover are not directional, so without a convention the same
  // pair could be stored twice reversed — storylineLinks has no ordering CHECK.
  // invariants.md §6 left this open; sorting these two is the decision.
  it.each(['parallel', 'crossover'] as const)('sorts the pair for %s', async (linkType) => {
    await service.linkStorylines(USER, 'zzz-story', 'aaa-story', linkType);

    expect(writer.insertStorylineLinkIfAbsent).toHaveBeenCalledWith({
      storylineAId: 'aaa-story',
      storylineBId: 'zzz-story',
      linkType,
    });
  });

  it('refuses a storyline the caller does not own', async () => {
    reader.ownedStorylineIds.mockResolvedValue(new Set(['aaa-story']));

    await expect(
      service.linkStorylines(USER, 'aaa-story', 'someone-elses', 'sequel')
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(writer.insertStorylineLinkIfAbsent).not.toHaveBeenCalled();
  });
});
