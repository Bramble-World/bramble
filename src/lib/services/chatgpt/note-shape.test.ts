import { describe, expect, it } from 'vitest';
import { noteShape } from './chatgpt.service';
import { SKIP_REASONS, situationsPrompt } from '@/lib/ai/prompts/situations.prompt';

describe('noteShape', () => {
  it('bands the size and counts paragraphs, and says nothing else', () => {
    expect(noteShape('ok')).toEqual({ noteSize: 'short', paragraphs: 1 });
    expect(noteShape(`${'a'.repeat(300)}\n\n${'b'.repeat(300)}`)).toEqual({
      noteSize: 'medium',
      paragraphs: 2,
    });
    expect(noteShape(['x'.repeat(600), 'y'.repeat(600), '  ', 'z'].join('\n\n'))).toEqual({
      noteSize: 'long',
      paragraphs: 3,
    });
  });
});

describe('the skip codes', () => {
  it('are all offered to the model, by name', () => {
    const { system } = situationsPrompt.render({ text: 'x' });
    for (const code of SKIP_REASONS) expect(system).toContain(code);
  });
});
