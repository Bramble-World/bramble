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

/**
 * Hard ceiling on the beats a single extraction may return.
 *
 * Bounded by wall-clock, not by quality. This is a non-streaming call, so no
 * response headers arrive until the whole object is generated — and Node's fetch
 * abandons a request after 300 seconds of waiting for them, which surfaces as
 * `UND_ERR_HEADERS_TIMEOUT` with no status code and three identical retries. A
 * 40-beat ceiling on a dense real conversation crossed that line; the extraction
 * was still working and the client had already given up.
 *
 * 20 is a deliberate middle: still two and a half times the flat 8 that left
 * four months of a founder conversation unplayable, and comfortably inside the
 * window at `medium` reasoning effort. Raising it again means fixing the
 * transport first — a dispatcher with a longer header timeout, or streaming so
 * the headers arrive immediately.
 */
export const MAX_BEATS = 20;

/**
 * How many beats a conversation of this size deserves.
 *
 * A flat cap was wrong in both directions. Eight beats is generous for a
 * forty-message thread and losing for a four-month one: a real founder
 * conversation spanning May to September came back with eight, its timeline
 * stopped two months before the story did, and the arc summary — which reads
 * the whole transcript — described funding and paperwork that existed nowhere
 * in the timeline. Half the story was not playable.
 *
 * Two inputs, because either alone misleads. Volume is the better guide to how
 * much happened, but a sparse conversation carried over months still has shape,
 * so elapsed time sets a floor: roughly a beat a fortnight. The result is
 * clamped at both ends — below the floor there is not enough story to play, and
 * above the ceiling structured output starts dropping array entries.
 */
export function beatTarget(messages: TranscriptMessage[]): number {
  const byVolume = Math.round(messages.length / 25);

  const times = messages.map((m) => new Date(m.sentAt).getTime()).filter((t) => !Number.isNaN(t));
  const spanDays = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;
  const bySpan = Math.round(spanDays / 14);

  return Math.min(MAX_BEATS, Math.max(6, byVolume, bySpan));
}

export type ExtractionVars = {
  user: UserContext;
  surface: string;
  messages: TranscriptMessage[];
};

export const extractionOutputSchema = z.object({
  title: z.string().min(1).describe('A short title for the story, under 60 characters.'),
  tone: z.string().min(1).describe('A few words describing how this story feels.'),
  setting: z
    .string()
    .nullable()
    .describe(
      'Where and when this takes place: place, period, circumstances. Not what happens in it and not how it turns out — this is shown on every turn, including the first.'
    ),
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
        description: z
          .string()
          .nullable()
          .describe(
            'Who they are as this story opens — their place in it, not what becomes of them. Written as if the rest has not happened yet: no "eventually", no "later", no outcomes.'
          ),
        voiceTone: z.string().nullable().describe('How they write — rhythm, register, habits.'),
        want: z
          .string()
          .min(1)
          .describe(
            'What this person is trying to get out of this, in their terms — something another person could give them or refuse them. Not a feeling.'
          ),
        avoids: z
          .string()
          .nullable()
          .describe(
            'What they are steering around. Null only if the conversation never shows one.'
          ),
      })
    )
    .min(1)
    // Raised from 6, which was provably binding: a real six-person conversation
    // cast exactly six, so there is no way to know who was dropped. A group
    // thread routinely has more, and a person who never gets cast never gets a
    // persons row and cannot be referred to again.
    .max(12),

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
    .max(16)
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
    // A ceiling, not the instruction. The number actually asked for is computed
    // per conversation and stated in the prompt; this only stops a runaway.
    .max(MAX_BEATS)
    .describe('The beats of the story, in the order they should be presented.'),

  background: z
    .array(
      z.object({
        content: z.string().min(1).describe('Something the exchange implies but never states.'),
        aboutName: z.string().nullable().describe('A cast name, or null for the whole story.'),
      })
    )
    .max(12),

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
      '- Cover the whole conversation, end to end. Stopping early because the story',
      '  feels complete leaves the rest of it unplayable — the later months of a long',
      '  thread are usually where the most has changed.',
      '- Date each beat from the messages it covers. The gap between two beats is',
      '  part of the story — three weeks of silence reads nothing like ten minutes.',
      '- Background is what the exchange implies but never says outright.',
      '- Motifs are running references between these people — not themes of the story.',
      '- If someone here is already in "People you already know", give their id.',
      '- relationshipType is the persistent fact (siblings, coworkers). The closeness,',
      '  tension and power fields are how they stand at the start of this story.',
      '- Write the setting and the cast descriptions from the beginning, not from',
      '  the end. You have read the whole conversation; the reader has not, and',
      '  these are shown to them from the very first beat. "The investor who offers',
      '  $300,000" and "a shared home, later a funded company" both hand over the',
      '  ending before the story starts. Say who someone is and where this is',
      '  happening, and let the beats do the rest.',
      '- Give everyone a want, including the quiet ones. A want is something another',
      '  person can grant or withhold: "wants the three of them to eat together',
      '  before the move is finished" is a want; "wants to feel respected" is not,',
      '  because nobody can hand it over. At least one pair of these wants must be',
      '  incompatible — if everyone can have what they want at once, there is no',
      '  story here and you have read it wrong.',
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
      `Produce the storyline. This conversation is ${messages.length} messages long; aim for about ${beatTarget(messages)} beats, spread across the whole of it rather than concentrated at the start.`,
    ]
      .filter((line) => line !== null)
      .join('\n'),
  }),
};
