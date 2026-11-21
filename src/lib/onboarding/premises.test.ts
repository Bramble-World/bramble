import { describe, expect, it } from 'vitest';
import { ARE_YOU_UP, PRONOUNS, type Naming } from './openings';
import { choosePremise, PREMISE_IDS, romanticPremises } from './premises';

const premises = romanticPremises(ARE_YOU_UP);
const naming = (relationship: Naming['relationship'], pronouns: Naming['pronouns'] = 'she') => ({
  name: 'Riley',
  relationship,
  pronouns,
});

describe('the premises behind the 1:47 AM opening', () => {
  it('are the ones analytics knows, the wedding first', () => {
    expect(premises.map((p) => p.id)).toEqual([...PREMISE_IDS]);
  });

  it.each(PREMISE_IDS)('%s: beat 1 follows the first screen and names the texter', (id) => {
    const premise = premises.find((p) => p.id === id)!;
    for (const relationship of ['ex', 'crush'] as const) {
      for (const pronouns of PRONOUNS) {
        const beat = premise.beat1(naming(relationship, pronouns));
        // Newest first: the text the first screen showed is the older one.
        expect(beat.surface.texts.at(-1)).toBe('hey. are you up?');
        expect(beat.surface.texts).toHaveLength(2);
        expect(beat.surface.clockTime).toBe('1:48');
        expect(beat.headline).toContain('Riley');
        expect(beat.choices).toHaveLength(3);
        // The texter's own pronouns, never a stray "them" for a he or a she.
        if (pronouns !== 'they') expect(beat.narrative).not.toMatch(/\bthem\b/);
      }
    }
  });

  it.each(PREMISE_IDS)(
    '%s: a "Text back" choice sends its quoted words; others send nothing',
    (id) => {
      const premise = premises.find((p) => p.id === id)!;
      for (const relationship of ['ex', 'crush'] as const) {
        for (const choice of premise.beat1(naming(relationship)).choices) {
          const quoted = /^Text back: "(.+)"$/.exec(choice.label);
          // The reply is exactly the words in the label, so the bubble the app
          // sends reads the same as the choice the reader picked.
          expect(choice.reply).toBe(quoted ? quoted[1] : null);
          if (choice.label.startsWith('Call ')) expect(choice.reply).toBeNull();
        }
      }
    }
  );

  it.each(PREMISE_IDS)('%s: sets up a story the model can continue', (id) => {
    const premise = premises.find((p) => p.id === id)!;
    for (const relationship of ['ex', 'crush'] as const) {
      const setup = premise.setup(naming(relationship));
      expect(setup.events.length).toBeGreaterThanOrEqual(2);
      expect(setup.events.every((e) => e.description.includes('Riley'))).toBe(true);
      expect(setup.storyline.title).toBe(setup.storyline.title.toLowerCase());
    }
  });
});

/**
 * A crush is someone you have never been with, whose feelings you don't know.
 * Players read the first crush stories as "a long lost ex who still desperately
 * wants you" (2026-11-21): every line of a crush's setup and beat 1 has to be
 * free of the ex story, or the model takes the cue and runs with it.
 */
const EX_MARKERS = [
  /\bstill\b/i,
  /were to each other/i,
  /once close/i,
  /close once/i,
  /broke up/i,
  /break-?up/i,
  /\bex\b/i,
  /\bdated\b/i,
  /\bdating\b/i,
  /back together/i,
  /used to/i,
  /moved on/i,
  /since it ended/i,
  /\bformer\b/i,
  /not talking about it/i,
  /do you remember/i,
];

/** Every string in a value, however deep. */
const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];

describe('a crush is never written as an ex', () => {
  it.each(PREMISE_IDS)('%s: no ex markers in the setup or beat 1', (id) => {
    const premise = premises.find((p) => p.id === id)!;
    for (const pronouns of PRONOUNS) {
      const crush = naming('crush', pronouns);
      const text = [...strings(premise.setup(crush)), ...strings(premise.beat1(crush))];
      for (const line of text) {
        for (const marker of EX_MARKERS) expect(line, `${id}: "${line}"`).not.toMatch(marker);
      }
    }
  });

  it.each(PREMISE_IDS)('%s: says you have never been together, in the present tense', (id) => {
    const setup = premises.find((p) => p.id === id)!.setup(naming('crush'));
    expect(setup.events[0].title).toBe('What you are to each other');
    expect(setup.events[0].description).toContain('Riley is your crush');
    expect(setup.events[0].description).toMatch(/never been together/);
    expect(setup.named.description).toMatch(/^Your crush/);
  });

  // What they want at 1:47 AM is the story's to find out, not the setup's to say.
  it.each(PREMISE_IDS)('%s: leaves what the crush wants open', (id) => {
    const setup = premises.find((p) => p.id === id)!.setup(naming('crush'));
    expect(setup.named.want).toMatch(/not said/);
    expect(setup.named.want).not.toMatch(/take back|more than tonight|what .* felt seeing you/);
  });

  it.each(PREMISE_IDS)('%s: an ex keeps the past together', (id) => {
    const setup = premises.find((p) => p.id === id)!.setup(naming('ex'));
    expect(setup.events[0].title).toBe('What you were to each other');
    expect(setup.events[0].description).toContain('Riley is your ex');
    expect(setup.named.description).toMatch(/^Your ex/);
  });

  it('gives a crush a photo with no night together in it', () => {
    const photo = premises.find((p) => p.id === 'found_the_photo')!;
    const crush = photo.beat1(naming('crush'));
    expect(crush.surface.texts[0]).toContain('group photo');
    expect(strings(photo.setup(naming('crush'))).join(' ')).not.toMatch(/roof/);
    expect(photo.beat1(naming('ex')).surface.texts[0]).toContain('that night on the roof');
  });
});

describe('choosing a premise', () => {
  it('is the same for the same guest', () => {
    const id = '4f1d0c3e-7b2a-4c9e-9f10-2a6b8d5e1c33';
    expect(choosePremise(ARE_YOU_UP, id, naming('ex'))).toBe(
      choosePremise(ARE_YOU_UP, id, naming('ex'))
    );
  });

  it('reaches every premise across guests', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(choosePremise(ARE_YOU_UP, `guest-${i}`, naming('crush')).id);
    }
    expect([...seen].sort()).toEqual([...PREMISE_IDS].sort());
  });

  it('keeps the wedding for a relationship only older builds send', () => {
    for (const relationship of ['old_friend', 'boss', 'sibling'] as const) {
      expect(choosePremise(ARE_YOU_UP, 'guest-1', naming(relationship)).id).toBe('wedding');
    }
  });
});
