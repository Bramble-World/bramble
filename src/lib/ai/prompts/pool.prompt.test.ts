import { describe, expect, it } from 'vitest';
import { SEED_STORIES } from '@/lib/pool/seeds';
import { checkPrompt, rewritePrompt } from './pool.prompt';

const answer = {
  question: 2 as const,
  role: 'teacher',
  text: 'Mr Okafor at Saint Brigid’s made me stay after class.',
};

describe('pool.rewrite', () => {
  const { system, prompt } = rewritePrompt.render({ answer, targetBeats: 20 });

  it('shows the model the answer, what it was asked, and the role', () => {
    expect(prompt).toContain(answer.text);
    expect(prompt).toContain('someone who changed your last life');
    expect(prompt).toContain('a teacher');
  });

  it('puts privacy first: replace identifiers, never quote', () => {
    expect(system).toContain('Replace every name, place, school, employer');
    expect(system).toContain('Never quote the answer');
  });

  it('tells the model to decline rather than pad a thin answer', () => {
    expect(system).toContain('Quality over quantity');
    expect(system).toContain('Do not pad a thin answer into a generic story');
  });

  it('refuses minors in danger, abuse and self-harm', () => {
    expect(system).toContain('minors in danger, abuse, or self-harm');
  });
});

describe('pool.check', () => {
  const story = Object.values(SEED_STORIES)[0];
  const { system, prompt } = checkPrompt.render({ answer, story });

  it('compares the story against the answer it came from', () => {
    expect(prompt).toContain(answer.text);
    expect(prompt).toContain(story.hook);
  });

  it('scores strictly, with only 4 and 5 played', () => {
    expect(system).toContain('Only 4 and 5 are played.');
    expect(system).toContain('identifier');
    expect(system).toContain('quotes_answer');
  });
});
