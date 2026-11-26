import { describe, expect, it } from 'vitest';
import { DUET_REJECT_CODES, duetCheckPrompt, duetWritePrompt, PAIRINGS } from './duet.prompt';
import { PARTNER } from '@/lib/duets/premise';
import { DUET_PREMISES } from '@/lib/duets/seeds';

describe('the duet prompts', () => {
  it('tell the writer the placeholder, the pairing and what is already written', () => {
    const { system, prompt } = duetWritePrompt.render({
      pairing: PAIRINGS[0],
      existing: [{ title: 'the surprise', setting: 'a lake house' }],
    });
    expect(system).toContain(PARTNER);
    expect(system).toContain(PAIRINGS[0]);
    expect(system).toMatch(/never romantic/i);
    expect(prompt).toContain('the surprise');
  });

  it('give the check every reject code by name', () => {
    const { system } = duetCheckPrompt.render({ premise: Object.values(DUET_PREMISES)[0] });
    for (const code of DUET_REJECT_CODES) expect(system).toContain(`${code}:`);
  });
});
