import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { StorylineContext } from '@/lib/services/generation/generation.types';

export type ArcVars = { storyline: StorylineContext };

export const arcOutputSchema = z.object({
  arcSummary: z
    .string()
    .min(1)
    .describe(
      'One or two sentences on how things changed across the whole story — where it started and where it stands now.'
    ),
});

export type ArcOutput = z.infer<typeof arcOutputSchema>;

/**
 * Re-describes a storyline once the reader has changed it.
 *
 * The summary is fed back into the turn prompt as "So far", so this is the one
 * place a long story gets compressed into something a later beat can be written
 * against. It is recomputed rather than appended to, because a summary of a
 * changed story is a different summary, not a longer one.
 */
export const arcPrompt: PromptSpec<ArcVars, ArcOutput> = {
  name: 'arc.summarise',
  stage: 'arc',
  schema: arcOutputSchema,

  render: ({ storyline }) => ({
    system: [
      'You summarise how a story changed, in one or two sentences.',
      '',
      'Rules:',
      '- Describe the shape of the change: where things started, where they stand.',
      '- Beats the reader caused are part of the story now. Do not distinguish them.',
      '- No preamble. Return the summary itself.',
    ].join('\n'),

    prompt: [
      `# ${storyline.storyline.title}`,
      '',
      '## Cast',
      ...storyline.characters.map((c) => `- ${c.name}${c.isSelf ? ' (the reader)' : ''}`),
      '',
      '## Between them',
      ...storyline.relationships.map((r) => {
        const dynamic = r.currentDynamic ?? r.baselineDynamic;
        const described = [dynamic?.closeness, dynamic?.tension, dynamic?.powerBalance]
          .filter(Boolean)
          .join('; ');
        return `- ${nameOf(storyline, r.characterAId)} and ${nameOf(storyline, r.characterBId)}${described ? `: ${described}` : ''}`;
      }),
      '',
      '## The whole timeline',
      ...storyline.timeline.map((b) => `${b.narrativeOrder}. ${b.title} — ${b.description}`),
      '',
      'Summarise the arc.',
    ].join('\n'),
  }),
};

function nameOf(storyline: StorylineContext, characterId: string): string {
  return storyline.characters.find((c) => c.id === characterId)?.name ?? 'someone';
}
