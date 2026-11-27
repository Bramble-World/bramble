import { describe, expect, it } from 'vitest';
import { STAGE_MODELS } from '../models';
import type { ChatGPTContext } from '@/lib/chatgpt/context';
import { SEED_STORIES } from '@/lib/pool/seeds';
import { personalCheckPrompt, personalRewritePrompt } from './personal.prompt';

const context: ChatGPTContext = {
  about: 'my best friend Priya got into the summer program and I did not.',
  people: [{ name: 'Priya', relationship: 'best friend', details: '' }],
  you: null,
};

describe('the prompts for a player’s own story', () => {
  it('are asked at the normal tier, the check thinking less than the writer', () => {
    expect(STAGE_MODELS[personalRewritePrompt.stage].flex).toBeUndefined();
    expect(STAGE_MODELS[personalCheckPrompt.stage].flex).toBeUndefined();
    expect(STAGE_MODELS[personalRewritePrompt.stage].reasoningEffort).toBe('medium');
    expect(STAGE_MODELS[personalCheckPrompt.stage].reasoningEffort).toBe('low');
  });

  it('tell the writer and the check the same rule about real people', () => {
    const writer = personalRewritePrompt.render({ context, targetBeats: 20 }).system;
    const check = personalCheckPrompt.render({
      context,
      story: SEED_STORIES['close-friends'],
    }).system;
    for (const system of [writer, check]) {
      expect(system).toContain('private or damaging');
    }
    // Filled-in detail is what the writer is asked for, so the check lets it through.
    expect(writer).toContain('Ordinary detail you fill in is fine.');
    expect(check).toContain('ordinary detail the writer was asked to fill in');
  });

  it('tell the writer and the check the same rule about the hook', () => {
    const writer = personalRewritePrompt.render({ context, targetBeats: 20 }).system;
    const check = personalCheckPrompt.render({
      context,
      story: SEED_STORIES['close-friends'],
    }).system;
    // The writer is told what a hook may name; the check lets exactly that through.
    expect(writer).toContain('It never says what');
    expect(writer).toContain('what anyone does or decides, or a twist');
    expect(check).toContain('an event, a');
    expect(check).toContain('the setting, the people and the situation they start in is not a');
  });

  it('remind the writer of the rule an earlier version broke, and only then', () => {
    const plain = personalRewritePrompt.render({ context, targetBeats: 20 }).system;
    expect(plain).not.toContain('An earlier version');
    const harms = personalRewritePrompt.render({
      context,
      targetBeats: 20,
      fix: 'harms_real_person',
    });
    expect(harms.system).toContain(
      'An earlier version was turned down because it had a named person'
    );
    const spoils = personalRewritePrompt.render({
      context,
      targetBeats: 20,
      fix: 'spoils_opening',
    });
    expect(spoils.system).toContain('its hook or opening lines gave too much away');
    expect(spoils.prompt).toBe(personalRewritePrompt.render({ context, targetBeats: 20 }).prompt);
  });
});
