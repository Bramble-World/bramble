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

const context = (overrides: Partial<StorylineContext> = {}): StorylineContext => ({
  storyline: { id: 's1', title: 'A story', setting: null, tone: null, arcSummary: null },
  characters: [],
  relationships: [],
  timeline: [beat(1000), beat(2000), beat(3000)],
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
