import { FakeGenerator } from './generator.fake';
import { turnPrompt } from './prompts/turn.prompt';
import { consequencePrompt } from './prompts/consequence.prompt';

/**
 * Canned output for every prompt, so the loop runs with no key and no spend.
 *
 * These deliberately read ids and orders out of the context they are given
 * rather than inventing them. A fixture returning made-up ids would exercise
 * only the path where the service discards what the model said, and the write
 * path — participants attached, relationship states anchored, a beat slotted
 * into a real gap — would never run at all. The point of playing the loop
 * against the fake is that everything downstream of the model is real.
 *
 * They vary by seed so a session does not read as the same beat four times, but
 * the same input always gives the same output: reproducible, not random.
 */
export function registerFixtures(fake: FakeGenerator): void {
  fake.register(turnPrompt, ({ vars, seed }) => {
    const others = vars.storyline.characters.filter((c) => !c.isSelf);
    const other = others[seed % Math.max(others.length, 1)]?.name ?? 'they';
    const beat = vars.storyline.timeline.at(-1);

    const openings = [
      `The message sits there, unsent. ${other} has not said anything for a while.`,
      `You read it back twice. ${other} is still typing, then stops.`,
      `There is a pause long enough to notice. ${other} is waiting on you.`,
    ];

    return {
      narrative: [
        openings[seed % openings.length],
        beat ? `After ${beat.title.toLowerCase()}, nothing has quite settled.` : '',
        'You could say the true thing, or the easy one.',
      ]
        .filter(Boolean)
        .join(' '),
      choices: [
        { label: 'Say the true thing', description: 'It will not be taken well.' },
        { label: 'Say the easy thing', description: null },
        { label: 'Say nothing yet', description: 'Let the silence do the work.' },
      ].slice(0, 2 + (seed % 2)),
    };
  });

  fake.register(consequencePrompt, ({ vars, seed }) => {
    // Every third decision changes nothing permanent, which is the realistic
    // shape and the one most likely to be handled wrongly.
    const changesCanon = seed % 3 !== 0;
    const anchor = vars.storyline.timeline.at(-1)?.narrativeOrder ?? 0;
    const cast = vars.storyline.characters;
    const relationship = vars.storyline.relationships[0];

    if (!changesCanon) {
      return {
        afterNarrativeOrder: anchor,
        events: [],
        contextEntries: [],
        relationshipStates: [],
      };
    }

    return {
      afterNarrativeOrder: anchor,
      events: [
        {
          title: 'A different answer',
          description: `You said something you did not say the first time, and it landed.`,
          stakes: 'Whatever was unsaid is now said.',
          participantCharacterIds: cast.slice(0, 2).map((c) => c.id),
          generationRationale:
            'The reader chose to be direct where the original exchange was evasive, so the story now has to account for that having been said out loud.',
        },
      ],
      contextEntries: [
        {
          content: 'This has been building for longer than either of them has admitted.',
          characterId: null,
        },
      ],
      relationshipStates: relationship
        ? [
            {
              relationshipId: relationship.id,
              closeness: 'closer, uncomfortably so',
              tension: 'lower, but not gone',
              powerBalance: null,
            },
          ]
        : [],
    };
  });
}
