import { describe, expect, it } from 'vitest';
import type { BeatContext, RelationshipContext, StorylineContext } from './generation.types';
import { contextAsOf, scriptExhausted } from './playhead';

const beat = (
  narrativeOrder: number,
  origin: BeatContext['origin'] = 'extracted'
): BeatContext => ({
  id: `beat-${narrativeOrder}`,
  narrativeOrder,
  title: `Beat ${narrativeOrder}`,
  description: 'x',
  stakes: null,
  origin,
  occurredAt: null,
  participantCharacterIds: [],
});

const relationship = (
  states: Array<{ narrativeOrder: number; label: string }>
): RelationshipContext => ({
  id: 'rel-1',
  characterAId: 'a',
  characterBId: 'b',
  relationshipType: null,
  baselineDynamic: { closeness: 'baseline' },
  currentDynamic: states.at(-1) ? { closeness: states.at(-1)!.label } : null,
  states: states.map((s) => ({
    narrativeOrder: s.narrativeOrder,
    dynamic: { closeness: s.label },
  })),
});

const person = (id: string, over: Partial<StorylineContext['characters'][number]> = {}) => ({
  id,
  personId: `p-${id}`,
  name: id.toUpperCase(),
  role: 'supporting' as const,
  description: null,
  voice: null,
  want: null,
  avoids: null,
  isSelf: false,
  ...over,
});

/** A beat with the two default cast members present, so they count as met. */
const peopled = (n: number) => ({ ...beat(n), participantCharacterIds: ['a', 'b'] });

const context = (overrides: Partial<StorylineContext> = {}): StorylineContext => ({
  storyline: { id: 's1', title: 'A story', setting: null, tone: null, arcSummary: null },
  characters: [person('a'), person('b')],
  relationships: [],
  timeline: [peopled(1000), peopled(2000), peopled(3000)],
  background: { storylineLevel: [], byCharacterId: {} },
  motifs: [],
  ...overrides,
});

describe('contextAsOf', () => {
  it('keeps what the reader has reached and hides what they have not', () => {
    const cut = contextAsOf(context(), 2000);
    expect(cut.timeline.map((b) => b.narrativeOrder)).toStrictEqual([1000, 2000]);
  });

  // The `<` / `<=` boundary. Getting it wrong hides the beat the reader is
  // standing on, which reads as the story forgetting what just happened.
  it('keeps a beat sitting exactly on the playhead', () => {
    expect(contextAsOf(context(), 1000).timeline.map((b) => b.narrativeOrder)).toStrictEqual([
      1000,
    ]);
  });

  it('shows nothing at all before the story starts', () => {
    expect(contextAsOf(context(), 0).timeline).toStrictEqual([]);
  });

  it('shows everything once the playhead is past the end', () => {
    expect(contextAsOf(context(), 99_999).timeline).toHaveLength(3);
  });

  /**
   * The quieter of the two leaks.
   *
   * `currentDynamic` renders under "Between them", and resolving it from the
   * highest-ordered state tells the model how two people end up feeling before
   * the story has taken them there.
   */
  it('resolves a relationship to how it stood at the playhead, not at the end', () => {
    const cut = contextAsOf(
      context({
        relationships: [
          relationship([
            { narrativeOrder: 1000, label: 'wary' },
            { narrativeOrder: 3000, label: 'reconciled' },
          ]),
        ],
      }),
      2000
    );

    expect(cut.relationships[0].currentDynamic).toStrictEqual({ closeness: 'wary' });
    expect(cut.relationships[0].states).toHaveLength(1);
  });

  // Null rather than the baseline, so the prompt's own `current ?? baseline`
  // fallback still distinguishes "nothing has moved" from "this is the start".
  it('leaves the dynamic unset when no state has been reached', () => {
    const cut = contextAsOf(
      context({ relationships: [relationship([{ narrativeOrder: 3000, label: 'reconciled' }])] }),
      2000
    );

    expect(cut.relationships[0].currentDynamic).toBeNull();
    expect(cut.relationships[0].baselineDynamic).toStrictEqual({ closeness: 'baseline' });
  });

  /**
   * The arc and consequence stages share this object and need all of it. A cut
   * that mutated in place would narrow their view too — silently, and only in
   * whichever ran second.
   */
  it('does not mutate the context it was given', () => {
    const original = context({
      relationships: [
        relationship([
          { narrativeOrder: 1000, label: 'wary' },
          { narrativeOrder: 3000, label: 'reconciled' },
        ]),
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(original));

    contextAsOf(original, 1000);

    expect(JSON.parse(JSON.stringify(original))).toStrictEqual(snapshot);
  });
});

/**
 * Who the reader has met.
 *
 * Extraction reads the whole conversation and describes the cast from the end
 * looking back, so a character who appears two months in arrives pre-loaded
 * with their ending. Measured: a real storyline's first turn named an investor
 * and proposed messaging him, at a playhead where the only visible beat was two
 * siblings in a kitchen — because the cast list described him as "the investor
 * who offers $300,000" and was rendered in full from turn one.
 */
describe('the cast the reader has met', () => {
  const later = (n: number, ids: string[]) => ({ ...beat(n), participantCharacterIds: ids });

  it('hides a character who has not appeared yet', () => {
    const cut = contextAsOf(
      context({
        characters: [person('a'), person('b'), person('investor', { name: 'Michael' })],
        timeline: [peopled(1000), later(9000, ['a', 'investor'])],
      }),
      1000
    );

    expect(cut.characters.map((c) => c.name)).toStrictEqual(['A', 'B']);
    expect(cut.characters.map((c) => c.id)).not.toContain('investor');
  });

  it('lets them in once the reader reaches a beat they are in', () => {
    const full = context({
      characters: [person('a'), person('b'), person('investor', { name: 'Michael' })],
      timeline: [peopled(1000), later(9000, ['a', 'investor'])],
    });

    expect(contextAsOf(full, 9000).characters.map((c) => c.id)).toContain('investor');
  });

  // The reader is present at their own story even in a beat that does not
  // happen to list them.
  it('always keeps the protagonist', () => {
    const cut = contextAsOf(
      context({
        characters: [person('self', { isSelf: true }), person('a')],
        timeline: [later(1000, ['a'])],
      }),
      1000
    );

    expect(cut.characters.map((c) => c.id)).toContain('self');
  });

  /**
   * Both ends, or the row renders a name the reader cannot place — and the
   * prompt's `nameOf` would fall back to "someone", which is worse than the row
   * being absent.
   */
  it('drops a relationship that reaches someone unmet', () => {
    const cut = contextAsOf(
      context({
        characters: [person('a'), person('b'), person('investor')],
        timeline: [peopled(1000)],
        relationships: [
          { ...relationship([]), id: 'known', characterAId: 'a', characterBId: 'b' },
          { ...relationship([]), id: 'unknown', characterAId: 'a', characterBId: 'investor' },
        ],
      }),
      1000
    );

    expect(cut.relationships.map((r) => r.id)).toStrictEqual(['known']);
  });
});

describe('scriptExhausted', () => {
  it('is false while real beats remain ahead', () => {
    expect(scriptExhausted(context(), 2000)).toBe(false);
  });

  it('is true once the last real beat is behind the reader', () => {
    expect(scriptExhausted(context(), 3000)).toBe(true);
  });

  // Beats the playthrough wrote itself are not remaining script. Counting them
  // would mean a diverged session could never be told it had left the source
  // conversation, which is exactly when it most needs to know.
  it('ignores the playthrough own beats when deciding', () => {
    const diverged = context({
      timeline: [beat(1000), beat(2000), beat(9000, 'conversation_generated')],
    });

    expect(scriptExhausted(diverged, 2000)).toBe(true);
  });

  it('is false at the very beginning of a story that has beats', () => {
    expect(scriptExhausted(context(), 0)).toBe(false);
  });
});
