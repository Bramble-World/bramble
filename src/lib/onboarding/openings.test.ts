import { describe, expect, it } from 'vitest';
import { ARE_YOU_UP, chooseOpening, OPENINGS, openingById, RELATIONSHIPS } from './openings';

/**
 * Beat 1 has to match the iPhone's bundled sample turn word for word — the app
 * shows the sample while the real one loads, and a reader should not see the
 * text change under them. These pin the exact strings.
 */
describe('the 1:47 AM opening', () => {
  it('shows the phone the first screen draws', () => {
    expect(ARE_YOU_UP.phone).toEqual({
      clockTime: '1:47',
      dateLabel: 'Saturday, June 14',
      text: 'hey. are you up?',
      timeLabel: '1:47 am',
    });
  });

  it('writes beat 1 with the name and pronouns slotted in', () => {
    expect(ARE_YOU_UP.beat1({ name: 'Jordan', relationship: 'ex', pronouns: 'he' })).toEqual({
      headline: 'Jordan is getting married tomorrow. And he just texted you.',
      narrative:
        "You stare at the screen until it dims, then tap it awake again. Three dots appear. Then they're gone.",
      choices: [
        'Text back: "i\'m up."',
        'Call Jordan right now',
        'Leave it on read and try to sleep',
      ],
      surface: {
        clockTime: '1:48',
        dateLabel: 'Saturday, June 14',
        texts: [
          "i know it's late. i'm getting married tomorrow and i need to say something before i do",
          'hey. are you up?',
        ],
      },
    });
  });

  it('keeps "is" after a name whatever the pronouns', () => {
    const beat = ARE_YOU_UP.beat1({ name: 'Sam', relationship: 'sibling', pronouns: 'they' });
    expect(beat.headline).toBe('Sam is getting married tomorrow. And they just texted you.');
    expect(ARE_YOU_UP.beat1({ name: 'Ana', relationship: 'crush', pronouns: 'she' }).headline).toBe(
      'Ana is getting married tomorrow. And she just texted you.'
    );
  });

  it.each(RELATIONSHIPS)('sets up a story the model can continue, for %s', (relationship) => {
    const setup = ARE_YOU_UP.setup({ name: 'Riley', relationship, pronouns: 'she' });
    expect(setup.storyline.title).toBe('the night before');
    expect(setup.events.length).toBeGreaterThanOrEqual(2);
    expect(setup.events.length).toBeLessThanOrEqual(4);
    expect(setup.events.every((e) => e.description.includes('Riley'))).toBe(true);
  });

  it('calls a sibling a brother or sister when the pronouns say which', () => {
    const description = (pronouns: 'he' | 'she' | 'they') =>
      ARE_YOU_UP.setup({ name: 'Riley', relationship: 'sibling', pronouns }).events[0].description;
    expect(description('he')).toContain('your brother');
    expect(description('she')).toContain('your sister');
    expect(description('they')).toContain('your sibling');
  });
});

describe('choosing an opening', () => {
  it('is the same opening for the same guest every time', () => {
    const id = '4f1d0c3e-7b2a-4c9e-9f10-2a6b8d5e1c33';
    expect(chooseOpening(id)).toBe(chooseOpening(id));
    expect(OPENINGS).toContain(chooseOpening(id));
  });

  it('finds openings by id, and nothing else', () => {
    expect(openingById('are_you_up')).toBe(ARE_YOU_UP);
    expect(openingById('nope')).toBeUndefined();
  });
});
