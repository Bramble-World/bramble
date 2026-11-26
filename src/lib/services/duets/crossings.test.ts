import { describe, expect, it } from 'vitest';
import { crossingVerdict, QUIET_AFTER_MS, type ReceiverFacts } from './crossings.service';
import { decidePush, type PushFacts } from '../push/push.policy';
import {
  consequencePrompt,
  consequenceOutputSchema,
  duetConsequenceOutputSchema,
  duetConsequencePrompt,
} from '@/lib/ai/prompts/consequence.prompt';
import { turnPrompt } from '@/lib/ai/prompts/turn.prompt';
import type { StorylineContext } from '@/lib/services/generation/generation.types';

const NOW = new Date('2026-11-26T18:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

const receiver = (change: Partial<ReceiverFacts> = {}): ReceiverFacts => ({
  present: true,
  ended: false,
  started: true,
  lastChoiceAt: ago(HOUR),
  startedAt: ago(2 * HOUR),
  ...change,
});

describe('crossingVerdict', () => {
  it('queues for a side in play', () => {
    expect(crossingVerdict(receiver(), NOW)).toBe('queue');
  });

  it('holds for a side not started yet, which opens with it', () => {
    expect(crossingVerdict(receiver({ started: false, lastChoiceAt: null }), NOW)).toBe('hold');
  });

  it('sends nothing to a player who left, or a side that ended', () => {
    expect(crossingVerdict(receiver({ present: false }), NOW)).toBe('gone');
    expect(crossingVerdict(receiver({ ended: true }), NOW)).toBe('ended');
  });

  it(`stops for a side quiet more than 3 days, and resumes once they choose again`, () => {
    expect(crossingVerdict(receiver({ lastChoiceAt: ago(QUIET_AFTER_MS + HOUR) }), NOW)).toBe(
      'quiet'
    );
    expect(crossingVerdict(receiver({ lastChoiceAt: ago(QUIET_AFTER_MS - HOUR) }), NOW)).toBe(
      'queue'
    );
    // Started but never chosen: counted from the start.
    expect(
      crossingVerdict(receiver({ lastChoiceAt: null, startedAt: ago(QUIET_AFTER_MS + HOUR) }), NOW)
    ).toBe('quiet');
  });
});

describe('"your story for two just moved"', () => {
  const facts = (change: Partial<PushFacts> = {}): PushFacts => ({
    lastTurnAt: ago(2 * HOUR),
    turnsInWindow: 3,
    oldestInWindow: ago(3 * HOUR),
    lastSeenAt: ago(2 * HOUR),
    timeZone: 'America/New_York',
    sends: [],
    lastSentAt: null,
    unlimitedEnergy: false,
    ...change,
  });

  it('goes once when something crossed and they have been away a while', () => {
    expect(decidePush(facts({ crossingWaiting: true }), NOW)).toEqual({
      kind: 'duet_moved',
      ordinal: 0,
    });
    expect(
      decidePush(
        facts({ crossingWaiting: true, sends: [{ kind: 'duet_moved', sentAt: ago(HOUR) }] }),
        NOW
      )
    ).toBeNull();
  });

  it('waits until they have been away half an hour, and never without a crossing', () => {
    expect(
      decidePush(facts({ crossingWaiting: true, lastSeenAt: ago(10 * 60 * 1000) }), NOW)
    ).toBeNull();
    expect(decidePush(facts({ crossingWaiting: false }), NOW)).toBeNull();
  });
});

const storyline: StorylineContext = {
  storyline: {
    id: 's1',
    title: 'A story',
    setting: null,
    tone: null,
    arcSummary: null,
    targetBeats: 20,
    openingId: null,
  },
  characters: [
    {
      id: '3f9a2b1c-0000-4000-8000-000000000001',
      personId: 'p1',
      name: 'Maya',
      isSelf: false,
    } as never,
  ],
  relationships: [],
  timeline: [],
  background: { storylineLevel: [], byCharacterId: {} },
  motifs: [],
};

describe('prompts outside a story for two', () => {
  const decision = {
    headline: null,
    narrativeContent: 'x',
    surfaceLines: [],
    chosenLabel: 'y',
    chosenDescription: null,
    rejectedLabels: [],
  };

  it('are the usual ones: no partner, no crossing, and no partnerKnows in the schema', () => {
    const plain = consequencePrompt.render({ storyline, playheadOrder: 0, decision });
    expect(plain.system).not.toMatch(/another real person/);
    expect(plain.prompt).not.toMatch(/other player/i);
    expect(JSON.stringify(consequenceOutputSchema.shape.events.element.shape)).not.toContain(
      'partnerKnows'
    );

    const turn = turnPrompt.render({
      storyline,
      session: { sessionId: 'x', storylineId: 's1', turns: [] },
      beyondScript: false,
      phase: 'open',
      beatsToEnding: null,
    });
    expect(turn.prompt).not.toMatch(/just did/);
  });

  it('a duet side is told who the other player is and asked what they would know', () => {
    const partnerCharacterId = storyline.characters[0].id;
    const duet = duetConsequencePrompt.render({
      storyline,
      playheadOrder: 0,
      decision,
      partnerCharacterId,
    });
    expect(duet.system).toMatch(/another real person/);
    expect(duet.prompt).toContain('The other player is 3f9a2b (Maya).');
    expect(Object.keys(duetConsequenceOutputSchema.shape.events.element.shape)).toContain(
      'partnerKnows'
    );
  });

  it("a crossing opens the next beat with the other player's texts", () => {
    const turn = turnPrompt.render({
      storyline,
      session: { sessionId: 'x', storylineId: 's1', turns: [] },
      beyondScript: false,
      phase: 'open',
      beatsToEnding: null,
      crossing: {
        partnerCharacterId: storyline.characters[0].id,
        title: 'The plan',
        description: 'She told the group the party is off.',
      },
    });
    expect(turn.prompt).toContain('## What Maya just did');
    expect(turn.prompt).toContain('The plan: She told the group the party is off.');
    expect(turn.prompt).toContain('[3f9a2b]');
  });
});
