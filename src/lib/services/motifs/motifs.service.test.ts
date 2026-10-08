import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/utils/errors';

vi.mock('./motifs.reader', () => ({
  getMotif: vi.fn(),
  listMotifs: vi.fn(),
  eventBelongsToStoryline: vi.fn(),
}));
vi.mock('./motifs.writer', () => ({
  insertMotif: vi.fn(),
  insertMotifOccurrenceIfAbsent: vi.fn(),
}));
vi.mock('../persons/persons.reader', () => ({ ownedPersonIds: vi.fn() }));
vi.mock('../storylines/storylines.reader', () => ({ getStoryline: vi.fn() }));

const reader = vi.mocked(await import('./motifs.reader'));
const writer = vi.mocked(await import('./motifs.writer'));
const personReader = vi.mocked(await import('../persons/persons.reader'));
const storylineReader = vi.mocked(await import('../storylines/storylines.reader'));
const service = await import('./motifs.service');

const USER = 'user-1';
const MOTIF = 'motif-1';
const STORY = 'story-1';
const motif = { id: MOTIF, label: 'the lasagna incident', description: null };
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

describe('createMotif', () => {
  it('requires a label', async () => {
    await expect(service.createMotif(USER, { label: '  ' })).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(writer.insertMotif).not.toHaveBeenCalled();
  });

  // motifParticipants has a single-column FK to persons and no idea whose motif
  // it hangs off, so a motif could otherwise be attached to another user's contact.
  it('refuses a participant the caller does not own', async () => {
    personReader.ownedPersonIds.mockResolvedValue(new Set(['p-1']));

    await expect(
      service.createMotif(USER, { label: 'inside joke' }, ['p-1', 'someone-elses'])
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(writer.insertMotif).not.toHaveBeenCalled();
  });

  it('de-duplicates participants before writing', async () => {
    personReader.ownedPersonIds.mockResolvedValue(new Set(['p-1']));
    writer.insertMotif.mockResolvedValue(motif);

    await service.createMotif(USER, { label: 'inside joke' }, ['p-1', 'p-1']);

    expect(writer.insertMotif).toHaveBeenCalledWith(USER, { label: 'inside joke' }, ['p-1']);
  });

  it('allows a motif with no participants yet', async () => {
    writer.insertMotif.mockResolvedValue(motif);

    await expect(service.createMotif(USER, { label: 'inside joke' })).resolves.toBe(motif);
    expect(personReader.ownedPersonIds).not.toHaveBeenCalled();
  });
});

describe('recordMotifOccurrence', () => {
  beforeEach(() => {
    reader.getMotif.mockResolvedValue(motif);
    storylineReader.getStoryline.mockResolvedValue(storyline);
    writer.insertMotifOccurrenceIfAbsent.mockResolvedValue({ id: 'occ-1' });
  });

  // invariants.md §3: "a callback pointing at the wrong story's beat".
  // motifOccurrences carries both storylineId and eventId with no FK relating them.
  it('refuses an event belonging to a different storyline', async () => {
    reader.eventBelongsToStoryline.mockResolvedValue(false);

    await expect(
      service.recordMotifOccurrence(USER, MOTIF, STORY, 'event-from-another-story')
    ).rejects.toBeInstanceOf(ValidationError);
    expect(writer.insertMotifOccurrenceIfAbsent).not.toHaveBeenCalled();
  });

  it('accepts an event that belongs to the storyline', async () => {
    reader.eventBelongsToStoryline.mockResolvedValue(true);

    await expect(
      service.recordMotifOccurrence(USER, MOTIF, STORY, 'event-1')
    ).resolves.toStrictEqual({ id: 'occ-1' });
  });

  // A motif can colour a whole storyline without attaching to one exact beat,
  // so the event lookup must be skipped entirely rather than run with undefined.
  it('allows an occurrence with no event, without checking one', async () => {
    await expect(service.recordMotifOccurrence(USER, MOTIF, STORY)).resolves.toStrictEqual({
      id: 'occ-1',
    });
    expect(reader.eventBelongsToStoryline).not.toHaveBeenCalled();
  });

  it.each([
    ['motif', () => reader.getMotif.mockResolvedValue(null)],
    ['storyline', () => storylineReader.getStoryline.mockResolvedValue(null)],
  ])('refuses a %s the caller does not own', async (_label, arrange) => {
    arrange();

    await expect(service.recordMotifOccurrence(USER, MOTIF, STORY)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(writer.insertMotifOccurrenceIfAbsent).not.toHaveBeenCalled();
  });

  it('reports an already-recorded occurrence as a conflict', async () => {
    writer.insertMotifOccurrenceIfAbsent.mockResolvedValue(null);

    await expect(service.recordMotifOccurrence(USER, MOTIF, STORY)).rejects.toBeInstanceOf(
      ConflictError
    );
  });
});
