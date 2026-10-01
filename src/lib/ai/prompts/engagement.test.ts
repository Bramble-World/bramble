import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_RUBRIC } from './timeline';
import { extractionPrompt, extractionOutputSchema } from './extraction.prompt';
import { consequencePrompt, consequenceOutputSchema } from './consequence.prompt';

/**
 * The engagement score has to mean the same thing in both prompts that write it.
 *
 * The reader's list spans every storyline they own, so a 7 from one extraction has
 * to be a 7 from another. That only holds if both prompts carry the same rubric —
 * and two copies of a paragraph drift, silently, in a way that looks exactly like
 * the model being inconsistent rather than the prompts having diverged.
 */
const vars = {
  user: { self: null, persons: [], motifs: [] },
  surface: 'imessage',
  messages: [
    {
      isFromMe: false,
      handle: 'c_0000000000000000',
      sender: 'Maya',
      text: 'x',
      sentAt: '2026-03-01T00:00:00.000Z',
    },
  ],
};

const consequenceVars = {
  // Shaped like the fixture in turn.prompt.test.ts: StorylineContext nests the
  // storyline's own fields under `storyline`, and the render reads them.
  storyline: {
    storyline: { id: 's1', title: 'A Story', setting: null, tone: null, arcSummary: null },
    characters: [],
    relationships: [],
    timeline: [],
    background: { storylineLevel: [], byCharacterId: {} },
    motifs: [],
  },
  decision: {
    narrativeContent: 'x',
    chosenLabel: 'y',
    chosenDescription: null,
    rejectedLabels: [],
  },
};

describe('the rubric reaches both prompts', () => {
  // Interpolated, never copied. If someone inlines it into one prompt and edits
  // it, this fails rather than the ranking quietly becoming noise.
  it.each([
    ['extraction', () => extractionPrompt.render(vars as never).system],
    ['consequence', () => consequencePrompt.render(consequenceVars as never).system],
  ])('%s carries the shared rubric verbatim', (_name, render) => {
    expect(render()).toContain(ENGAGEMENT_RUBRIC);
  });

  /**
   * The anchors must be absolute, not relative to the conversation at hand. A
   * model told to rate "relative to these beats" gives its best one a 9 every
   * time, three storylines produce three 9s, and the ranking collapses into ties.
   */
  it('tells the model not to grade on a curve', () => {
    expect(ENGAGEMENT_RUBRIC).toMatch(/never against the other beats/i);
    expect(ENGAGEMENT_RUBRIC).toMatch(/do not grade on a curve/i);
  });

  // It scores playability as an entry point, which is not the same as importance —
  // the most consequential beat is usually a quiet aftermath.
  it('scores where to begin, not what mattered most', () => {
    expect(ENGAGEMENT_RUBRIC).toMatch(/start playing/i);
    expect(ENGAGEMENT_RUBRIC).toMatch(/not how important/i);
  });
});

describe('both schemas hold the same bounds', () => {
  const extraction = (score: unknown) =>
    extractionOutputSchema.shape.beats.element.safeParse({
      title: 't',
      description: 'd',
      stakes: null,
      occurredAt: null,
      participantNames: [],
      engagementScore: score,
    }).success;

  const consequence = (score: unknown) =>
    consequenceOutputSchema.shape.events.element.safeParse({
      title: 't',
      description: 'd',
      stakes: null,
      participantCharacterIds: [],
      actorCharacterId: null,
      generationRationale: 'r',
      engagementScore: score,
    }).success;

  it.each([
    ['extraction', extraction],
    ['consequence', consequence],
  ])('%s accepts 1 through 10 and nothing else', (_name, parse) => {
    expect(parse(1)).toBe(true);
    expect(parse(10)).toBe(true);
    expect(parse(0)).toBe(false);
    expect(parse(11)).toBe(false);
    // A float would silently truncate on the way into an integer column.
    expect(parse(3.5)).toBe(false);
    // Absent is not optional: a beat with no score is unrankable, and the model
    // should be told that rather than left to omit it.
    expect(parse(undefined)).toBe(false);
  });
});
