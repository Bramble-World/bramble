import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { UserContext } from '@/lib/services/generation/generation.types';

/** One message as it reaches the pipeline. Never written to any column. */
export type TranscriptMessage = {
  isFromMe: boolean;
  /**
   * The conversation this belongs to. Used for grouping only — in a group chat
   * every message shares one, which is exactly why it cannot also serve as the
   * speaker.
   */
  handle: string;
  /**
   * Who wrote it. Distinct from `handle`, and the distinction matters: reading
   * the speaker off the thread made everyone in a group chat indistinguishable,
   * so the model could not name them, could not cast them, and would have given
   * two different people the same contact hash.
   */
  sender: string;
  text: string;
  sentAt: string;
};

export type ExtractionVars = {
  user: UserContext;
  surface: string;
  messages: TranscriptMessage[];
};

export const extractionOutputSchema = z.object({
  title: z.string().min(1).describe('A short title for the story, under 60 characters.'),
  tone: z.string().min(1).describe('A few words describing how this story feels.'),
  setting: z.string().nullable().describe('Narrative framing, if one suggests itself.'),
  arcSummary: z
    .string()
    .min(1)
    .describe('One or two sentences on how things changed over the conversation.'),

  cast: z
    .array(
      z.object({
        name: z.string().min(1).describe('What to call this person in the story.'),
        existingPersonId: z
          .string()
          .nullable()
          .describe(
            'An id from "People you already know" when this is the same person. Null if new.'
          ),
        sourceHandle: z
          .string()
          .nullable()
          .describe(
            'The exact name this person sent messages under, copied from the transcript. Null if they are only mentioned and never wrote.'
          ),
        role: z.enum(['protagonist', 'antagonist', 'supporting']),
        description: z.string().nullable().describe('Who they are in this particular story.'),
        voiceTone: z.string().nullable().describe('How they write — rhythm, register, habits.'),
      })
    )
    .min(1)
    .max(6),

  relationships: z
    .array(
      z.object({
        betweenNames: z.array(z.string()).length(2).describe('Two names from the cast.'),
        relationshipType: z
          .string()
          .nullable()
          .describe('What they are to each other in life — "siblings", "coworkers". Not a mood.'),
        closeness: z.string().nullable(),
        tension: z.string().nullable(),
        powerBalance: z.string().nullable(),
      })
    )
    .max(6)
    .describe('How the cast stand at the start of this story.'),

  beats: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().min(1).describe('What happened, retold. Not a quotation.'),
        stakes: z.string().nullable(),
        occurredAt: z
          .string()
          .nullable()
          .describe(
            'When this beat happened, ISO 8601, taken from the timestamps on the messages it covers. Use the moment it turns on. Null if it spans no particular one.'
          ),
        participantNames: z.array(z.string()).describe('Names from the cast above.'),
      })
    )
    .min(1)
    .max(8)
    .describe('The beats of the story, in the order they should be presented.'),

  background: z
    .array(
      z.object({
        content: z.string().min(1).describe('Something the exchange implies but never states.'),
        aboutName: z.string().nullable().describe('A cast name, or null for the whole story.'),
      })
    )
    .max(6),

  motifs: z
    .array(
      z.object({
        label: z.string().min(1).describe('A short name, e.g. "the lasagna incident".'),
        description: z.string().nullable(),
        participantNames: z.array(z.string()),
      })
    )
    .max(4)
    .describe('Running jokes and callbacks. These belong to the people, not the story.'),
});

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/**
 * Turns a conversation into a storyline.
 *
 * The transcript goes in and nothing of it comes back out: every field of the
 * schema is a description, a retelling or a judgement, and none of them is a
 * place a message could be copied into. invariants.md §1 makes that a product
 * claim rather than a preference, so the instruction is explicit rather than
 * implied by the field names.
 *
 * The model is shown people the user already has so it can recognise someone it
 * has seen before. Matching by id is what makes a person the same `persons` row
 * across two storylines, which is the entire basis for cross-storyline
 * continuity — and it is also why the service checks the id it gets back rather
 * than trusting it.
 */
export const extractionPrompt: PromptSpec<ExtractionVars, ExtractionOutput> = {
  name: 'extraction.storyline',
  stage: 'extraction',
  schema: extractionOutputSchema,

  render: ({ user, surface, messages }) => ({
    system: [
      'You turn a real conversation into the outline of a story.',
      '',
      'The person whose account this is is the protagonist. Others are drawn from',
      'how they actually write.',
      '',
      'Rules:',
      '- Never quote or reproduce the messages. Describe what happened instead.',
      '  Every field you return is a retelling, not an excerpt. This is not a style',
      '  preference: the messages are not stored anywhere, and anything you copy',
      '  into a description would be the only copy left.',
      '- Beats are what changed, not every exchange. A long conversation that went',
      '  nowhere is one beat.',
      '- Date each beat from the messages it covers. The gap between two beats is',
      '  part of the story — three weeks of silence reads nothing like ten minutes.',
      '- Background is what the exchange implies but never says outright.',
      '- Motifs are running references between these people — not themes of the story.',
      '- If someone here is already in "People you already know", give their id.',
      '- relationshipType is the persistent fact (siblings, coworkers). The closeness,',
      '  tension and power fields are how they stand at the start of this story.',
    ].join('\n'),

    prompt: [
      user.self ? `You are extracting for ${user.self.name}.` : null,
      `Surface: ${surface}`,
      '',
      ...(user.persons.length
        ? ['## People you already know', ...user.persons.map((p) => `- ${p.id} — ${p.name}`), '']
        : []),
      ...(user.motifs.length
        ? [
            '## Running references already recorded',
            ...user.motifs.map((m) => `- ${m.label}${m.description ? `: ${m.description}` : ''}`),
            '',
          ]
        : []),
      // Named before the transcript, because a long group chat makes it easy to
      // lose a quieter participant, and a dropped speaker is a person who never
      // gets a persons row and cannot be referred to again.
      ...(() => {
        const speakers = [...new Set(messages.filter((m) => !m.isFromMe).map((m) => m.sender))];
        return speakers.length > 1
          ? [
              '## Who is in this conversation',
              ...speakers.map((name) => `- ${name}`),
              'Everyone above who took part belongs in the cast.',
              '',
            ]
          : [];
      })(),
      '## The conversation',
      ...messages.map((m) => `[${m.sentAt}] ${m.isFromMe ? 'me' : m.sender}: ${m.text}`),
      '',
      'Produce the storyline.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }),
};
