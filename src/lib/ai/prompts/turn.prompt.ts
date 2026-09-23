import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { SessionContext, StorylineContext } from '@/lib/services/generation/generation.types';

export type TurnVars = {
  storyline: StorylineContext;
  session: SessionContext;
};

/**
 * Nullable rather than optional throughout.
 *
 * OpenAI's structured output mode requires every property to be present, and
 * expresses "absent" as null. An `.optional()` field either gets rejected or
 * silently never appears, so the schema says nullable and the caller normalises.
 */
export const turnOutputSchema = z.object({
  narrative: z
    .string()
    .min(1)
    .describe('What happens next, in second person, 2-5 sentences. No dialogue attribution.'),
  choices: z
    .array(
      z.object({
        label: z.string().min(1).describe('A short imperative, under 60 characters.'),
        description: z
          .string()
          .nullable()
          .describe('One clause on what this choice risks. Null if the label says enough.'),
      })
    )
    .min(2)
    .max(4)
    .describe('Distinct options. No option may be a rephrasing of another.'),
});

export type TurnOutput = z.infer<typeof turnOutputSchema>;

export const turnPrompt: PromptSpec<TurnVars, TurnOutput> = {
  name: 'turn.generate',
  stage: 'turn',
  schema: turnOutputSchema,

  render: ({ storyline, session }) => ({
    system: [
      'You write one beat of an interactive story drawn from a real conversation.',
      '',
      'The reader is the protagonist. Write to them as "you".',
      '',
      'Rules:',
      '- Stay inside what the timeline and background establish. Do not invent new people.',
      '- Characters speak in their own voice. Use the voice notes where given.',
      '- Background is what you know, not what you state. Let it shape the beat.',
      '- Offer choices that lead somewhere different from each other. Two choices that',
      '  amount to the same decision are one choice.',
      '- Do not resolve the story. A beat ends on a decision, not a conclusion.',
    ].join('\n'),

    prompt: [
      `# ${storyline.storyline.title}`,
      storyline.storyline.tone ? `Tone: ${storyline.storyline.tone}` : null,
      storyline.storyline.setting ? `Setting: ${storyline.storyline.setting}` : null,
      storyline.storyline.arcSummary ? `So far: ${storyline.storyline.arcSummary}` : null,
      '',
      '## Cast',
      ...storyline.characters.map((character) =>
        [
          `- ${character.name}${character.isSelf ? ' (you)' : ''} — ${character.role}`,
          character.description ? `  ${character.description}` : null,
          character.voice?.tone ? `  Voice: ${character.voice.tone}` : null,
          character.voice?.quirks?.length ? `  Quirks: ${character.voice.quirks.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      ),
      '',
      '## Between them',
      ...storyline.relationships.map((relationship) => {
        const a = nameOf(storyline, relationship.characterAId);
        const b = nameOf(storyline, relationship.characterBId);
        const dynamic = relationship.currentDynamic ?? relationship.baselineDynamic;
        const described = [dynamic?.closeness, dynamic?.tension, dynamic?.powerBalance]
          .filter(Boolean)
          .join('; ');
        return `- ${a} and ${b}${relationship.relationshipType ? ` (${relationship.relationshipType})` : ''}${described ? `: ${described}` : ''}`;
      }),
      '',
      '## What has happened',
      ...storyline.timeline.map(
        (beat) => `${beat.narrativeOrder}. ${beat.title} — ${beat.description}`
      ),
      '',
      ...(storyline.background.storylineLevel.length
        ? [
            '## Background (known, not stated)',
            ...storyline.background.storylineLevel.map((b) => `- ${b}`),
            '',
          ]
        : []),
      ...(storyline.motifs.length
        ? [
            '## Recurring',
            ...storyline.motifs.map(
              (m) => `- ${m.label}${m.description ? `: ${m.description}` : ''}`
            ),
            '',
          ]
        : []),
      ...(session.turns.length
        ? [
            '## This playthrough so far',
            ...session.turns.map((turn) =>
              turn.selectedChoiceLabel
                ? `- ${turn.narrativeContent}\n  You chose: ${turn.selectedChoiceLabel}`
                : `- ${turn.narrativeContent}\n  (unanswered)`
            ),
            '',
          ]
        : []),
      session.turns.length
        ? 'Write the next beat, following on from the choice just made.'
        : 'Write the opening beat of this playthrough.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }),
};

function nameOf(storyline: StorylineContext, characterId: string): string {
  return storyline.characters.find((c) => c.id === characterId)?.name ?? 'someone';
}
