import { describe, expect, it } from 'vitest';
import type {
  BeatContext,
  SessionContext,
  StorylineContext,
} from '@/lib/services/generation/generation.types';
import { contextAsOf } from '@/lib/services/generation/playhead';
import { CACHE_BREAK, CACHE_STEP, joinLines, splitAt, steppedBreaks, withBreaks } from './cache';
import { turnPrompt } from './turn.prompt';
import { consequencePrompt } from './consequence.prompt';

describe('joinLines', () => {
  it('joins exactly as filter-and-join did, and says where each break is', () => {
    const lines = ['# Title', null, 'a', CACHE_BREAK, 'b', '', CACHE_BREAK, 'c'];
    const { prompt, cacheBreaks } = joinLines(lines);

    expect(prompt).toBe(['# Title', 'a', 'b', '', 'c'].join('\n'));
    // Each break starts a line, so the stretch before it ends on its newline.
    expect(cacheBreaks.map((at) => prompt.slice(at))).toEqual(['b\n\nc', 'c']);
    expect(splitAt(prompt, cacheBreaks).join('')).toBe(prompt);
  });

  it('marks nothing for a break at the very start or end, or twice in one place', () => {
    const { cacheBreaks } = joinLines([
      CACHE_BREAK,
      'a',
      CACHE_BREAK,
      CACHE_BREAK,
      'b',
      CACHE_BREAK,
    ]);
    expect(cacheBreaks).toEqual([2]);
  });
});

describe('steppedBreaks', () => {
  it('cuts at the last two multiples of the step, so the next request repeats one', () => {
    expect(steppedBreaks(-3)).toEqual([0]);
    expect(steppedBreaks(3)).toEqual([0]);
    expect(steppedBreaks(4)).toEqual([0, 4]);
    expect(steppedBreaks(11)).toEqual([4, 8]);
    // Growing by up to a step keeps one cut in common.
    for (let n = 0; n < 40; n++) {
      for (let grow = 0; grow <= CACHE_STEP; grow++) {
        const shared = steppedBreaks(n).filter((at) => steppedBreaks(n + grow).includes(at));
        expect(shared.length).toBeGreaterThan(0);
      }
    }
  });

  it('places a break before the item at each index', () => {
    expect(withBreaks(['x', 'y'], [0, 2])).toEqual([CACHE_BREAK, 'x', 'y', CACHE_BREAK]);
  });
});

/**
 * A playthrough of one story, beat by beat, the way the services build each
 * request: the consequences of every choice land after the playhead, which is
 * raised to cover them; background is learned; a relationship moves; and the
 * playthrough grows. The timeline also has unreached script ahead, as a story
 * from an imported conversation does.
 */
const SELF = {
  id: 'self',
  personId: 'p0',
  name: 'Blossom',
  role: 'protagonist' as const,
  description: null,
  voice: null,
  want: 'to be asked, for once',
  avoids: 'making the first move',
  isSelf: true,
};
const MAYA = {
  ...SELF,
  id: 'c1',
  personId: 'p1',
  name: 'Maya',
  role: 'supporting' as const,
  isSelf: false,
};

const beat = (order: number, participants: string[] = ['c1']): BeatContext => ({
  id: `e${order}`,
  narrativeOrder: order,
  title: `Beat at ${order}`,
  description: `Something specific happens at ${order}, and it matters to both of them.`,
  stakes: `What ${order} puts at risk.`,
  origin: 'extracted',
  occurredAt: new Date(Date.UTC(2025, 0, 1) + order * 3_600_000).toISOString(),
  participantCharacterIds: participants,
});

type World = { storyline: StorylineContext; session: SessionContext; playhead: number };

function start(): World {
  return {
    playhead: 12_000,
    storyline: {
      storyline: {
        id: 's1',
        title: 'The spare key',
        setting: 'A shared flat',
        tone: 'wry, unhurried',
        arcSummary: null,
        targetBeats: 20,
        openingId: null,
      },
      characters: [SELF, MAYA],
      relationships: [
        {
          id: 'r1',
          characterAId: 'self',
          characterBId: 'c1',
          relationshipType: 'friend',
          baselineDynamic: { closeness: 'close' },
          currentDynamic: { closeness: 'close' },
          states: [],
        },
      ],
      // Twelve reached, eight still ahead.
      timeline: Array.from({ length: 20 }, (_, i) => beat((i + 1) * 1000)),
      background: { storylineLevel: ['The lease ends in June.'], byCharacterId: {} },
      motifs: [{ id: 'm1', label: 'the spare key', description: null, personIds: [] }],
    },
    session: { sessionId: 'sess-1', storylineId: 's1', turns: [] },
  };
}

/** One choice and its consequences, as `workOutConsequences` writes them. */
function choose(world: World, n: number, events: number): World {
  // Answering steps the playhead to the next beat (`advancePlayhead`), then the
  // consequences are inserted after it and the playhead raised over them.
  const stepped = world.storyline.timeline.find((b) => b.narrativeOrder > world.playhead);
  const playhead = stepped?.narrativeOrder ?? world.playhead;
  const after = world.storyline.timeline.findIndex((b) => b.narrativeOrder > playhead);
  const next = after === -1 ? playhead + 1000 : world.storyline.timeline[after].narrativeOrder;
  const added = Array.from({ length: events }, (_, i) => ({
    ...beat(Math.floor(playhead + ((next - playhead) * (i + 1)) / (events + 1))),
    origin: 'conversation_generated' as const,
  }));
  const timeline = [...world.storyline.timeline, ...added].sort(
    (a, b) => a.narrativeOrder - b.narrativeOrder
  );
  return {
    playhead: added.at(-1)?.narrativeOrder ?? playhead,
    storyline: {
      ...world.storyline,
      timeline,
      background: {
        ...world.storyline.background,
        storylineLevel: [...world.storyline.background.storylineLevel, `Learned on beat ${n}.`],
      },
      relationships: world.storyline.relationships.map((r) => ({
        ...r,
        currentDynamic: { closeness: `closer after beat ${n}` },
      })),
    },
    session: {
      ...world.session,
      turns: [
        ...world.session.turns,
        {
          turnOrder: n,
          headline: `Maya texts on beat ${n}.`,
          narrativeContent: `You read it twice on beat ${n}.`,
          surfaceLines: [`Maya texted: are you up (${n})`],
          choices: [],
          selectedChoiceLabel: `Answer on beat ${n}`,
          selectedChoiceReply: `yeah (${n})`,
        },
      ],
    },
  };
}

const turnRequest = (world: World) =>
  turnPrompt.render({
    storyline: contextAsOf(world.storyline, world.playhead),
    session: world.session,
    beyondScript: false,
    phase: 'open',
    beatsToEnding: null,
  });

const consequenceRequest = (world: World) =>
  consequencePrompt.render({
    storyline: world.storyline,
    playheadOrder: world.playhead,
    decision: {
      headline: 'Maya texts.',
      narrativeContent: `You read it twice (${world.session.turns.length}).`,
      surfaceLines: [],
      chosenLabel: 'Answer',
      chosenDescription: null,
      rejectedLabels: ['Leave it'],
    },
  });

/**
 * The longest prefix of `next` that is served from the cache `previous` wrote:
 * a boundary both requests carry, with the same text before it. On GPT-5.6 and
 * later nothing else can be read back. 0 is only the system message.
 */
function servedFromCache(
  previous: { prompt: string; cacheBreaks?: number[] },
  next: { prompt: string; cacheBreaks?: number[] }
): number {
  const shared = (next.cacheBreaks ?? []).filter(
    (at) =>
      previous.cacheBreaks?.includes(at) &&
      previous.prompt.slice(0, at) === next.prompt.slice(0, at)
  );
  return Math.max(0, ...shared);
}

/** How long the prefix two requests have in common is, boundary or not. */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

describe('consecutive beats of one story', () => {
  it('give the turn prompt no boundary inside it without the breaks, which is the ~1,341 tokens', () => {
    const one = turnRequest(start());
    const two = turnRequest(choose(start(), 1, 2));
    // Most of the request repeats...
    expect(commonPrefix(one.prompt, two.prompt)).toBeGreaterThan(one.prompt.length / 3);
    // ...but sent as one block, the only boundary the two share is the system's.
    expect(servedFromCache({ prompt: one.prompt }, { prompt: two.prompt })).toBe(0);
  });

  it('share a cut inside the timeline on every beat, behind only the stakes window and a step', () => {
    let world = start();
    let previous = turnRequest(world);
    for (let n = 1; n <= 30; n++) {
      // Up to two consequences, after the next scripted beat while any is left.
      world = choose(world, n, n % 3);
      const next = turnRequest(world);

      const served = servedFromCache(previous, next);
      const visible = contextAsOf(world.storyline, world.playhead).timeline;
      const timelineStart = next.prompt.indexOf('## What has happened');
      // Everything up to the timeline, and all of the timeline but the newest
      // beats, which move with every choice.
      const uncachedBeats = next.prompt.slice(served, next.prompt.indexOf('\n\n## Background'));
      const beatsLeft = (uncachedBeats.match(/^\d+\. /gm) ?? []).length;
      expect(served).toBeGreaterThan(timelineStart);
      expect(beatsLeft).toBeLessThanOrEqual(5 + 2 * CACHE_STEP);
      expect(visible.length).toBeGreaterThan(beatsLeft);

      previous = next;
    }
  });

  it('cuts the consequence prompt before the playhead, where its beats are inserted', () => {
    let world = start();
    let previous = consequenceRequest(world);
    for (let n = 1; n <= 12; n++) {
      world = choose(world, n, 2);
      const next = consequenceRequest(world);

      const served = servedFromCache(previous, next);
      // At least the cast and relationships, and the cut never reaches past
      // the text the two requests really share.
      expect(served).toBeGreaterThanOrEqual(next.prompt.indexOf('## Timeline'));
      expect(served).toBeLessThanOrEqual(commonPrefix(previous.prompt, next.prompt));
      // Inside the reached timeline once it is long enough: no further back
      // than the stakes window and two steps from the playhead.
      const reached = next.prompt.slice(served, next.prompt.indexOf(`${world.playhead}. `));
      expect((reached.match(/^\d+\. /gm) ?? []).length).toBeLessThanOrEqual(5 + 2 * CACHE_STEP);
      previous = next;
    }
  });

  it('does not change what the model reads', () => {
    const world = choose(choose(start(), 1, 2), 2, 1);
    for (const request of [turnRequest(world), consequenceRequest(world)]) {
      expect(request.prompt).not.toContain('Symbol');
      expect(splitAt(request.prompt, request.cacheBreaks ?? []).join('')).toBe(request.prompt);
      expect(request.cacheBreaks?.length).toBeGreaterThan(0);
    }
  });
});
