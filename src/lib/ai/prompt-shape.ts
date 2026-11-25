import { createHash } from 'node:crypto';
import type { RenderedPrompt } from './prompt';
import { splitAt } from './prompts/cache';

/**
 * What a request was made of, as fingerprints: enough to see, between two
 * consecutive beats of one session, which part changed first and so where the
 * prompt cache stopped. Never the text.
 *
 * Each part is `<hash>:<characters>`, the hash being the first 8 hex characters
 * of the part's SHA-256. Two beats whose `blocks[0]` match share that block's
 * cache; the first section whose hash differs is what broke the prefix.
 *
 * - `key` is the cache key hashed the same way, so one session's beats can be
 *   grouped without its id in the line.
 * - `system` is the system message.
 * - `blocks` are the stretches the prompt is sent as, each but the last ending
 *   on a cache breakpoint (prompts/cache.ts).
 * - `sections` are the prompt's `## ` sections in order, by heading. The part
 *   before the first heading, which carries the story's title, is `head`; a
 *   heading that is not one of ours (story text can contain a line that starts
 *   with `## `) is counted into the section before it rather than named.
 */
export type PromptShape = {
  key: string | null;
  system: string;
  blocks: string[];
  sections: string[];
};

/** The headings the turn and consequence prompts write. Anything else is text. */
const HEADINGS = new Set([
  'Recurring',
  'What has happened',
  'Background (known, not stated)',
  'Cast',
  'Between them',
  'This playthrough so far',
  'Where the story is',
  'Relationships',
  'Timeline',
  'The decision',
]);

export function promptShape(rendered: RenderedPrompt, cacheKey?: string): PromptShape {
  const { system, prompt, cacheBreaks = [] } = rendered;
  return {
    key: cacheKey ? hash(cacheKey) : null,
    system: fingerprint(system),
    blocks: splitAt(prompt, cacheBreaks).map(fingerprint),
    sections: sections(prompt).map(([name, text]) => `${name}:${fingerprint(text)}`),
  };
}

function sections(prompt: string): [string, string][] {
  const found: [string, string[]][] = [['head', []]];
  for (const line of prompt.split('\n')) {
    const heading = line.startsWith('## ') ? line.slice(3) : null;
    if (heading !== null && HEADINGS.has(heading)) found.push([heading, [line]]);
    else found.at(-1)![1].push(line);
  }
  return found.map(([name, lines]) => [name, lines.join('\n')]);
}

function fingerprint(text: string): string {
  return `${hash(text)}:${text.length}`;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}
