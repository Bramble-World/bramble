import { describe, expect, it } from 'vitest';
import { fitSituation, shorten } from './fit';

const person = (
  name: string,
  relationship = 'best friend',
  details = 'They met in ninth grade.'
) => ({
  name,
  relationship,
  details,
});

describe('fitSituation', () => {
  it('keeps a situation that already fits, unchanged', () => {
    const raw = {
      about: 'Jordan texted after six months.',
      people: [person('Jordan', 'ex')],
      you: null,
    };
    expect(fitSituation(raw)).toEqual({
      context: { about: raw.about, people: [person('Jordan', 'ex')], you: null },
      notes: [],
    });
  });

  // These were each dropped whole before, so a link of real situations
  // answered "chatgpt didn't find a story there".
  it('keeps the first three people of four', () => {
    const fitted = fitSituation({
      about: 'The group chat went quiet after the party.',
      people: [person('Maya'), person('Priya'), person('Sam'), person('Leo')],
      you: null,
    });
    expect(fitted.context?.people.map((p) => p.name)).toEqual(['Maya', 'Priya', 'Sam']);
    expect(fitted.notes).toEqual(['people']);
  });

  it('shortens a long relationship and long details at a word or sentence', () => {
    const details = `${'She always says she will call back and then she does not. '.repeat(8)}`;
    const fitted = fitSituation({
      about: 'Maya cancelled again.',
      people: [
        person('Maya', 'my best friend since middle school who moved away last year', details),
      ],
      you: 'A college sophomore who hates conflict.',
    });
    const maya = fitted.context!.people[0];
    expect(maya.relationship.length).toBeLessThanOrEqual(40);
    expect(maya.relationship).toBe('my best friend since middle school who');
    expect(maya.details.length).toBeLessThanOrEqual(300);
    expect(maya.details.endsWith('.')).toBe(true);
    expect(fitted.notes.sort()).toEqual(['details', 'relationship']);
  });

  it('fills a missing relationship, and drops people with no name', () => {
    const fitted = fitSituation({
      about: 'Someone left a note on the car.',
      people: [
        { name: ' ', relationship: 'neighbour', details: '' },
        { name: 'Ana', relationship: '', details: '' },
      ],
      you: '',
    });
    expect(fitted.context?.people).toEqual([
      { name: 'Ana', relationship: 'someone in their life', details: '' },
    ]);
    expect(fitted.context?.you).toBeNull();
  });

  it('drops only a situation with nothing to write from', () => {
    expect(fitSituation({ about: '  ', people: [person('Ana')], you: null })).toEqual({
      context: null,
      notes: ['no_text'],
    });
    expect(fitSituation({ about: 'A quiet week.', people: [], you: null })).toEqual({
      context: null,
      notes: ['no_people'],
    });
  });
});

describe('shorten', () => {
  it('leaves short text alone, trimmed', () => {
    expect(shorten('  hi there  ', 40)).toBe('hi there');
  });

  it('cuts at a word when there is no sentence end in reach', () => {
    expect(shorten('one two three four five', 13)).toBe('one two three');
  });
});
