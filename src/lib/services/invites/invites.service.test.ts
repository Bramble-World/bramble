import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  firstNameSchema,
  generateCode,
  normalizeCode,
} from './invites.service';
import { neutralNameFor } from '../duets/duets.service';

describe('invite codes', () => {
  it('are six letters, never one that looks like another', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
      expect(code).not.toMatch(/[ILO0-9]/);
    }
  });

  it('read the same however they were typed', () => {
    expect(normalizeCode(' abc def ')).toBe('ABCDEF');
  });
});

describe('first names', () => {
  it('take a name with accents, hyphens and apostrophes, trimmed', () => {
    expect(firstNameSchema.parse('  Zoë ')).toBe('Zoë');
    expect(firstNameSchema.parse("Mary-Kate O'Neil".slice(0, 16))).toBe("Mary-Kate O'Neil");
  });

  it('refuse empty, too long, or anything that is not a name', () => {
    for (const bad of ['', '   ', 'a'.repeat(17), '12345', 'hi :)', '@maya']) {
      expect(firstNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('neutralNameFor', () => {
  it('picks a name nobody in the story has', () => {
    expect(neutralNameFor(['Sky'])).toBe('Rowan');
    expect(neutralNameFor(['sky', 'ROWAN'])).toBe('Jules');
  });
});
