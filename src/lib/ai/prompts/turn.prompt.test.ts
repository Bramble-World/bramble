import { describe, expect, it } from 'vitest';
import type { SessionContext, StorylineContext } from '@/lib/services/generation/generation.types';
import { turnPrompt, TurnVars } from './turn.prompt';

const storyline = (overrides: Partial<StorylineContext> = {}): StorylineContext => ({
  storyline: {
    id: 's1',
    title: 'A story',
    setting: null,
    tone: null,
    arcSummary: 'It began badly and ends reconciled.',
  },
  characters: [],
  relationships: [],
  timeline: [
    {
      id: 'b1',
      narrativeOrder: 1000,
      title: 'Where things stood',
      description: 'They had not spoken in weeks.',
      stakes: null,
      origin: 'extracted',
      occurredAt: null,
      participantCharacterIds: [],
    },
  ],
  background: { storylineLevel: [], byCharacterId: {} },
  motifs: [],
  ...overrides,
});

const session: SessionContext = { sessionId: 'sess-1', storylineId: 's1', turns: [] };

const render = (vars: Partial<TurnVars> = {}) =>
  turnPrompt.render({ storyline: storyline(), session, beyondScript: false, ...vars });

describe('turn prompt', () => {
  /**
   * The arc summary is computed from the *whole* timeline, so rendering it into
   * a turn hands the model the ending however carefully the timeline itself is
   * cut. It was the last channel leaking the future, and it is not worth the
   * compression it bought.
   */
  it('never states the arc summary, which describes beats the reader has not reached', () => {
    const { prompt } = render();

    expect(prompt).not.toContain('So far:');
    expect(prompt).not.toContain('It began badly and ends reconciled.');
  });

  it('still renders the history the reader has reached', () => {
    const { prompt } = render();

    expect(prompt).toContain('## What has happened');
    expect(prompt).toContain('Where things stood');
  });

  // Reachable now that the timeline is cut: a playhead of 0 leaves nothing, and
  // a bare heading reads to the model as history that was withheld.
  it('says so plainly when nothing has happened yet', () => {
    const { prompt } = render({ storyline: storyline({ timeline: [] }) });

    expect(prompt).toContain('Nothing yet. This is the very beginning.');
  });

  /**
   * The two regimes fail in opposite directions, so the model is told which one
   * it is in. With script left it copies the next real beat; with none left it
   * has been observed to stall — three consecutive turns of nobody replying.
   */
  it('tells the model when the source conversation has run out', () => {
    expect(render({ beyondScript: true }).system).toContain('has run out');
    expect(render({ beyondScript: false }).system).not.toContain('has run out');
  });
});
