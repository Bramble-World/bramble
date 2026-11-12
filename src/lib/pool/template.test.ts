import { describe, expect, it } from 'vitest';
import { SEED_STORIES } from './seeds';
import { storyTemplateSchema, templateText } from './template';

describe('seed stories', () => {
  it('are all valid pool stories, so the pool is never empty', () => {
    expect(Object.keys(SEED_STORIES).length).toBeGreaterThanOrEqual(10);
    for (const story of Object.values(SEED_STORIES)) {
      expect(storyTemplateSchema.safeParse(story).success).toBe(true);
    }
  });

  it('have distinct, lowercase titles', () => {
    const titles = Object.values(SEED_STORIES).map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) expect(title).toBe(title.toLowerCase());
  });
});

describe('templateText', () => {
  it('reaches every string in a story, nested ones included', () => {
    const story = Object.values(SEED_STORIES)[0];
    const text = templateText(story);

    expect(text).toContain(story.hook);
    for (const line of story.openingLines) expect(text).toContain(line);
    expect(text).toContain(story.cast[0].name);
    expect(text).toContain(story.opening.at(-1)!.description);
    for (const line of story.background) expect(text).toContain(line);
  });
});
