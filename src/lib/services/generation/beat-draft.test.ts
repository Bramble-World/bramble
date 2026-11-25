import { describe, expect, it } from 'vitest';
import { beatDraft, isEmptyDraft, type DraftCastMember } from './beat-draft';

const cast: DraftCastMember[] = [
  { id: 'c-you', personId: 'p-you', isSelf: true, name: 'Blossom' },
  { id: 'c-maya', personId: 'p-maya', isSelf: false, name: 'Maya' },
];

const texts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ senderCharacterId: 'c-maya', text: `text ${i + 1}` }));

const phone = {
  isEnding: false,
  headline: 'Maya texts you at 1:47.',
  surfaceKind: 'imessage_notifications' as const,
  clockTime: '1:47',
  dateLabel: 'Saturday, June 14',
};

const sentTexts = (draft: ReturnType<typeof beatDraft>) =>
  draft.surfaces.flatMap((s) => s.notifications.map((n) => `${n.sender.name}: ${n.text}`));

describe('a beat draft', () => {
  it('holds the headline back until the model has moved past it', () => {
    expect(isEmptyDraft(beatDraft({ isEnding: false, headline: 'Maya tex' }, cast))).toBe(true);
    expect(
      beatDraft({ isEnding: false, headline: phone.headline, surfaceKind: 'none' }, cast).headline
    ).toBe(phone.headline);
  });

  it('sends each text once the next one has started, never half of one', () => {
    expect(sentTexts(beatDraft({ ...phone, notifications: texts(1) }, cast))).toStrictEqual([]);
    expect(sentTexts(beatDraft({ ...phone, notifications: texts(2) }, cast))).toStrictEqual([
      'Maya: text 1',
    ]);
  });

  it('sends the last text once the narrative has started', () => {
    const draft = beatDraft({ ...phone, notifications: texts(2), narrative: 'You' }, cast);
    expect(sentTexts(draft)).toStrictEqual(['Maya: text 1', 'Maya: text 2']);
    expect(draft.narrative).toBeNull();
  });

  it('sends the narrative once the choices have started', () => {
    const draft = beatDraft(
      { ...phone, notifications: texts(1), narrative: 'You put the phone down.', choices: [] },
      cast
    );
    expect(draft.narrative).toBe('You put the phone down.');
  });

  it('drops a text from someone the reader cannot get one from, as the saved beat does', () => {
    const draft = beatDraft(
      {
        ...phone,
        notifications: [
          { senderCharacterId: 'c-you', text: 'from yourself' },
          { senderCharacterId: 'c-stranger', text: 'from nobody' },
          { senderCharacterId: 'c-maya', text: 'are you up' },
        ],
        narrative: 'You',
      },
      cast
    );
    expect(sentTexts(draft)).toStrictEqual(['Maya: are you up']);
  });

  it('shows no phone for a beat that is not texts', () => {
    const draft = beatDraft(
      {
        isEnding: false,
        headline: 'Rosa hands you the marker.',
        surfaceKind: 'none',
        clockTime: null,
        dateLabel: null,
        notifications: [],
        narrative: 'You',
        choices: [],
      },
      cast
    );
    expect(draft.surfaces).toStrictEqual([]);
    expect(draft.headline).toBe('Rosa hands you the marker.');
  });
});
