import { describe, expect, it } from 'vitest';
import { resolveSurfaces, surfaceHistoryLine, surfacePersonIds, surfacesFromModel } from '.';
import type { SurfaceCastMember, SurfaceModelFields, SurfacePerson } from '.';

const reader: SurfaceCastMember = { id: 'c0', personId: 'p0', isSelf: true };
const maya: SurfaceCastMember = { id: 'c1', personId: 'p1', isSelf: false };
const theo: SurfaceCastMember = { id: 'c2', personId: 'p2', isSelf: false };
const cast = [reader, maya, theo];

const people = new Map<string, SurfacePerson>([
  ['p1', { id: 'p1', name: 'Maya', isSelf: false }],
  ['p2', { id: 'p2', name: 'Theo', isSelf: false }],
]);

const texts = (
  notifications: SurfaceModelFields['notifications'],
  over: Partial<SurfaceModelFields> = {}
): SurfaceModelFields => ({
  surfaceKind: 'imessage_notifications',
  clockTime: '1:47',
  dateLabel: 'Saturday, June 14',
  notifications,
  ...over,
});

describe('surfaces from the model', () => {
  it('stores a text from a met character with both of their ids', () => {
    expect(
      surfacesFromModel(texts([{ senderCharacterId: 'c1', text: ' are you up ' }]), cast)
    ).toStrictEqual([
      {
        type: 'imessage_notifications',
        version: 1,
        payload: {
          clockTime: '1:47',
          dateLabel: 'Saturday, June 14',
          notifications: [{ characterId: 'c1', personId: 'p1', text: 'are you up' }],
        },
      },
    ]);
  });

  it('shows nothing for a text-only beat', () => {
    expect(surfacesFromModel(texts([], { surfaceKind: 'none' }), cast)).toStrictEqual([]);
  });

  // The one thing the model may not invent is a person, and nobody texts
  // themselves. The cast passed in is already cut to who the reader has met, so
  // "not in the cast" covers "not met yet".
  it.each([
    ['someone not in the cast', 'c9'],
    ['the reader', 'c0'],
    ['a name instead of an id', 'Maya'],
  ])('drops a text from %s', (_label, senderCharacterId) => {
    expect(surfacesFromModel(texts([{ senderCharacterId, text: 'hey' }]), cast)).toStrictEqual([]);
  });

  it('keeps the valid texts when only some are bad', () => {
    const [surface] = surfacesFromModel(
      texts([
        { senderCharacterId: 'c9', text: 'from nobody' },
        { senderCharacterId: 'c2', text: 'from Theo' },
        { senderCharacterId: 'c1', text: '   ' },
      ]),
      cast
    );
    expect(surface.payload).toMatchObject({
      notifications: [{ characterId: 'c2', personId: 'p2', text: 'from Theo' }],
    });
  });

  it('drops a text too long for a lock screen', () => {
    expect(
      surfacesFromModel(texts([{ senderCharacterId: 'c1', text: 'x'.repeat(241) }]), cast)
    ).toStrictEqual([]);
  });

  it('shows at most three', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ senderCharacterId: 'c1', text: `${i}` }));
    const [surface] = surfacesFromModel(texts(many), cast);
    expect((surface.payload as { notifications: unknown[] }).notifications).toHaveLength(3);
  });

  it('falls back to the real clock rather than storing a time that is not one', () => {
    const [surface] = surfacesFromModel(
      texts([{ senderCharacterId: 'c1', text: 'hey' }], {
        clockTime: 'late, the night after the party',
        dateLabel: '  ',
      }),
      cast
    );
    expect(surface.payload).toMatchObject({ clockTime: null, dateLabel: null });
  });
});

describe('surfaces read back', () => {
  const stored = surfacesFromModel(
    texts([
      { senderCharacterId: 'c2', text: 'answer maya' },
      { senderCharacterId: 'c1', text: 'are you up' },
    ]),
    cast
  );

  it('names the people a surface mentions, once each', () => {
    expect(surfacePersonIds([...stored, ...stored])).toStrictEqual(['p2', 'p1']);
  });

  it('resolves senders to the people the reader knows', () => {
    expect(resolveSurfaces(stored, people)).toStrictEqual([
      {
        type: 'imessage_notifications',
        clockTime: '1:47',
        dateLabel: 'Saturday, June 14',
        notifications: [
          { sender: { id: 'p2', name: 'Theo', isSelf: false }, text: 'answer maya' },
          { sender: { id: 'p1', name: 'Maya', isSelf: false }, text: 'are you up' },
        ],
      },
    ]);
  });

  it('drops a text whose sender no longer exists, and a surface left with none', () => {
    const onlyMaya = new Map([['p1', people.get('p1')!]]);
    expect(resolveSurfaces(stored, onlyMaya)[0].notifications).toHaveLength(1);
    expect(resolveSurfaces(stored, new Map())).toStrictEqual([]);
  });

  // A surface type from a newer build, or a payload that no longer fits its
  // schema, must not make the turn unplayable — the rest of it still renders.
  it.each([
    ['an unknown type', { type: 'boarding_pass', version: 1, payload: { gate: 'B12' } }],
    ['an unknown version', { type: 'imessage_notifications', version: 99, payload: {} }],
    ['a payload that does not fit', { type: 'imessage_notifications', version: 1, payload: {} }],
  ])('skips %s', (_label, row) => {
    expect(resolveSurfaces([row, ...stored], people)).toHaveLength(1);
    expect(surfacePersonIds([row])).toStrictEqual([]);
  });

  it('remembers the texts in the order they were sent', () => {
    const [surface] = resolveSurfaces(stored, people);
    expect(surfaceHistoryLine(surface)).toBe(
      'On your phone — Maya: "are you up"; Theo: "answer maya"'
    );
  });
});
