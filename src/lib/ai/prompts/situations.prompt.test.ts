import { describe, expect, it } from 'vitest';
import { chatgptContextSchema } from '@/lib/chatgpt/context';
import { MAX_LINK_SITUATIONS, situationsOutputSchema, situationsPrompt } from './situations.prompt';

const note = 'my ex Jordan texted me after six months.\n\nI have a doctor appointment on friday.';

describe('chatgpt.situations', () => {
  const { system, prompt } = situationsPrompt.render({ text: note });

  it('shows the model the note, and only there', () => {
    expect(prompt).toContain(note);
    expect(system).not.toContain(note);
  });

  it('keeps the kinds of situation that make a story', () => {
    expect(system).toContain('crushes, exes, fights, secrets, rivalries');
    expect(system).toContain(`at most ${MAX_LINK_SITUATIONS} situations`);
  });

  it('drops what is sensitive, whatever the note says', () => {
    expect(system).toContain('Drop, whatever the note says');
    for (const topic of [
      'medical care',
      'sexual health (such as STIs)',
      'mental-health crises, self-harm',
      'money and debt',
      'legal trouble',
      'addresses',
      'work or school logistics',
      'anything at all sexual involving a minor',
      'too thin to play',
    ]) {
      expect(system).toContain(topic);
    }
  });

  it('keeps real names as given and never invents one', () => {
    expect(system).toContain('Keep their first names');
    expect(system).toContain('Never invent a name');
  });
});

describe('situationsOutputSchema', () => {
  const situation = {
    about: 'my ex Jordan texted me happy birthday after six months and I never answered.',
    people: [{ name: 'Jordan', relationship: 'ex', details: 'we broke up in march' }],
    you: null,
  };

  it('takes an empty list: nothing worth a story', () => {
    expect(situationsOutputSchema.parse({ situations: [] })).toEqual({ situations: [] });
  });

  it('takes a situation that is also what write_my_story takes', () => {
    const { situations } = situationsOutputSchema.parse({ situations: [situation] });
    expect(chatgptContextSchema.safeParse(situations[0]).success).toBe(true);
  });

  it("leaves lengths to write_my_story's schema, which a situation with no one in it fails", () => {
    const { situations } = situationsOutputSchema.parse({
      situations: [{ ...situation, people: [] }],
    });
    expect(chatgptContextSchema.safeParse(situations[0]).success).toBe(false);
  });

  it('requires every field', () => {
    expect(situationsOutputSchema.safeParse({ situations: [{ about: 'x' }] }).success).toBe(false);
  });
});
