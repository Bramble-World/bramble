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

/**
 * Who acts, and whether the model is allowed to invent.
 *
 * Measured before this change, across one storyline's 17 generated beats: the
 * reader was the subject of 12, one housemate of 4, and the third housemate of
 * none — while being present in 11 of them. She reacted in the prose and never
 * initiated, because nothing gave her anything of her own to drive at.
 */
describe('agency and invention', () => {
  it('asks for a character who starts something, not one who merely answers', () => {
    const { system } = render();

    expect(system).toContain('starts something');
    expect(system).toContain('furniture');
  });

  /**
   * Framed as judgement, not as a rota. Rotating whose turn it is would replace
   * one formula with another; the instruction is to pick whoever has most at
   * stake, and only then to notice if that keeps being the same person.
   */
  it('makes the choice of who acts a judgement rather than a rotation', () => {
    const { system } = render();

    expect(system).toContain('most interesting to hear from');
    expect(system).toContain('rotate for a reason, never to be fair');
  });

  it('licenses invention while keeping the cast closed', () => {
    const { system } = render();

    expect(system).toContain('Invent what happens next');
    expect(system).toContain('may not invent is a person');
    // The sentence this replaced forbade exactly the new situations the story
    // needs. It must not drift back in.
    expect(system).not.toContain('Stay inside what the timeline');
  });

  it('tells the model what this particular story is good at', () => {
    const { prompt } = render({
      storyline: {
        ...storyline(),
        storyline: { ...storyline().storyline, tone: 'wry, unhurried' },
      },
    });

    expect(prompt).toContain('Play this for its register: wry, unhurried');
    // It used to be a bare label the model could note and ignore.
    expect(prompt).not.toMatch(/^Tone: /m);
  });
});

/** Background about a particular person was assembled and then dropped. */
describe('per-character background', () => {
  const withBackground = (byCharacterId: Record<string, string[]>, storylineLevel: string[] = []) =>
    turnPrompt.render({
      storyline: {
        ...storyline(),
        characters: [
          {
            id: 'c1',
            personId: 'p1',
            name: 'Maya',
            role: 'supporting',
            description: null,
            voice: null,
            isSelf: false,
          },
        ],
        background: { storylineLevel, byCharacterId },
      },
      session,
      beyondScript: false,
    });

  it('names the person a piece of background is about', () => {
    const { prompt } = withBackground({ c1: ['She has been covering the rent since March.'] });

    // The whole bullet, so the id-to-name resolution is asserted: matching only
    // the sentence would pass if a raw uuid were rendered in place of the name.
    expect(prompt).toContain('- Maya: She has been covering the rent since March.');
  });

  // The guard used to be on storylineLevel.length, which rendered nothing at all
  // for a storyline whose background was entirely per-character.
  it('renders the section when only per-character background exists', () => {
    const { prompt } = withBackground({ c1: ['She has been covering the rent.'] });
    expect(prompt).toContain('## Background (known, not stated)');
  });

  it('drops background about someone who is not in the cast', () => {
    const { prompt } = withBackground({ ghost: ['Something about nobody.'] });

    expect(prompt).not.toContain('Something about nobody.');
    expect(prompt).not.toContain('someone:');
  });
});
