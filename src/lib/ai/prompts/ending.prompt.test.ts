import { describe, expect, it } from 'vitest';
import { endingPrompt } from './ending.prompt';

const session = {
  sessionId: 's',
  storylineId: 'l',
  turns: [
    {
      turnOrder: 1,
      headline: 'Maya just texted you.',
      narrativeContent: 'You read it twice.',
      surfaceLines: ['Maya: are you up'],
      choices: [],
      selectedChoiceLabel: 'Text back',
    },
    {
      turnOrder: 2,
      headline: null,
      narrativeContent: 'The train pulls out without you.',
      surfaceLines: [],
      choices: [],
      selectedChoiceLabel: null,
    },
  ],
};

describe('ending.summarise', () => {
  const { system, prompt } = endingPrompt.render({
    title: 'the night before',
    tone: 'tender',
    people: ['Maya'],
    session,
  });

  it('shows the playthrough beat by beat, with what was chosen and where it ended', () => {
    expect(prompt).toContain('### Beat 1');
    expect(prompt).toContain('You chose: Text back');
    expect(prompt).toContain('(the last beat: the story ended here)');
    expect(prompt).toContain('People: Maya');
  });

  it('describes only what happened, with choices re-worded as "you …"', () => {
    expect(system).toContain('Describe only what happened in the beats below.');
    expect(system).toContain('re-worded as "you …"');
  });
});
