import { z } from 'zod';
import { PromptSpec } from '../prompt';
import { SessionContext, StorylineContext } from '@/lib/services/generation/generation.types';
import { renderTimeline } from './timeline';
import { SURFACE_KINDS } from '@/lib/surfaces';
import { MAX_NOTIFICATIONS } from '@/lib/surfaces/imessage.surface';

export type TurnVars = {
  storyline: StorylineContext;
  session: SessionContext;
  /**
   * True once no extracted beat remains ahead of the reader.
   *
   * Worth telling the model explicitly, because the two regimes fail in
   * opposite directions. With script left it copies the next real beat; with
   * none left it has been observed to stall instead of invent, writing three
   * consecutive turns of nobody replying.
   */
  beyondScript: boolean;
};

/**
 * Nullable rather than optional throughout.
 *
 * OpenAI's structured output mode requires every property to be present, and
 * expresses "absent" as null. An `.optional()` field either gets rejected or
 * silently never appears, so the schema says nullable and the caller normalises.
 */
export const turnOutputSchema = z.object({
  headline: z
    .string()
    .min(1)
    .describe('The hook: one present-tense sentence to "you" saying what just happened.'),
  narrative: z
    .string()
    .min(1)
    .describe(
      'What you do or feel now, in second person, 1-3 sentences. Never repeats the headline or the words on a surface. No dialogue attribution.'
    ),
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
  // The surface, flattened into the turn rather than nested: nested optional
  // structures are where structured output is least reliable (see the
  // consequence prompt's `dynamic`). `surfaceKind` says which of the fields
  // below mean anything; with `none` they are null and empty.
  surfaceKind: z
    .enum(SURFACE_KINDS)
    .describe('Where this beat is shown. none unless the beat is texts arriving on your phone.'),
  clockTime: z
    .string()
    .nullable()
    .describe(
      'The time on the lock screen, like "1:47". Null if the moment has no particular time.'
    ),
  dateLabel: z
    .string()
    .nullable()
    .describe('The date under the clock, like "Saturday, June 14". Null if unknown.'),
  notifications: z
    .array(
      z.object({
        senderCharacterId: z.string().describe('The id of the cast member who sent it.'),
        text: z.string().describe('The text itself, as they would type it.'),
      })
    )
    .max(MAX_NOTIFICATIONS)
    .describe('Newest first. Empty unless surfaceKind is imessage_notifications.'),
});

export type TurnOutput = z.infer<typeof turnOutputSchema>;

export const turnPrompt: PromptSpec<TurnVars, TurnOutput> = {
  name: 'turn.generate',
  stage: 'turn',
  schema: turnOutputSchema,

  render: ({ storyline, session, beyondScript }) => {
    const stage = onStage(storyline);

    return {
      system: [
        'You write one beat of an interactive story drawn from a real conversation.',
        '',
        'The reader is the protagonist. Write to them as "you".',
        '',
        'Rules:',
        '- Do not open by restating what the reader chose. They know what they did.',
        '  Start from what it caused: the reply, the silence, the thing it set off.',
        '- Someone other than the reader starts something in most beats — not merely',
        '  answers. Adding to what the reader raised is responding; bringing their own',
        '  concern into it is acting. A character who only ever responds is furniture.',
        '- Choose whoever it is most interesting to hear from, which is often not the',
        '  person who spoke last. Usually it is whoever has most to gain or lose from',
        '  what just happened. Over several beats this should not be the same person',
        '  every time — but rotate for a reason, never to be fair.',
        '- Invent what happens next. The timeline and background are what is already',
        '  true, not a limit on what may happen: new events, new complications and new',
        '  information are yours to make, so long as they follow from these people and',
        '  the world they live in. The one thing you may not invent is a person — the',
        '  cast you are given is everyone.',
        '- Characters speak in their own voice. Use the voice notes where given.',
        '- Background is what you know, not what you state. Let it shape the beat.',
        '- Mind the time between beats. A reply that took three weeks is a different',
        '  reply from one that took an hour, and the silences are part of the story.',
        '- Offer choices that differ in kind, not in wording. At most one may ask for',
        '  information; at least one must risk something — saying the awkward thing,',
        '  committing to something, or letting a moment pass. A turn where every option',
        '  is a question is a turn where nothing can happen.',
        '- Do not resolve the story. A beat ends on a decision, not a conclusion.',
        '',
        'Shape of a beat:',
        '- headline is the hook, one sentence: what just happened, to "you".',
        '- narrative is what you do or feel now. It never repeats the headline, and it',
        '  never repeats words that appear on a surface.',
        '',
        'Surfaces:',
        '- When this beat is someone texting the reader right now, show it on their',
        '  phone: set surfaceKind to imessage_notifications and write the texts as',
        `  notifications — 1 to ${MAX_NOTIFICATIONS}, newest first. Each comes from a cast member other`,
        '  than you, named by the id in brackets, and is written in their own voice and',
        '  texting register. The texts are the beat; the narrative is your reaction.',
        '- Otherwise set surfaceKind to none, clockTime and dateLabel to null, and leave',
        '  notifications empty. Most beats are not texts — do not reach for a phone to',
        '  make a scene feel modern.',
        ...(beyondScript
          ? [
              '',
              'The conversation this story came from has run out. There is no next',
              'real event waiting to be told — whatever happens now is something',
              'these people have not done before. Invent it from who they are, and',
              'do not stall: silence and non-reply are not a beat.',
            ]
          : []),
      ].join('\n'),

      prompt: [
        `# ${storyline.storyline.title}`,
        // Directive, not descriptive. Extraction already reads the register well
        // — "ambitious, funny, increasingly strained" — and it was rendered as a
        // label the model could note and ignore. What a story optimises for is the
        // one thing that genuinely differs between a romance, a grudge and a
        // fundraise, and it is the model's own reading of this conversation.
        storyline.storyline.tone
          ? `Play this for its register: ${storyline.storyline.tone}. That is what this story is good at — lean on it rather than writing around it.`
          : null,
        storyline.storyline.setting ? `Setting: ${storyline.storyline.setting}` : null,
        // `arcSummary` is deliberately NOT rendered. It is computed from the whole
        // timeline, including beats the reader has not reached, so it was the one
        // remaining channel leaking the ending into a turn. What has happened
        // below is already this playthrough's history, and it is bounded.
        '',
        '## Cast',
        ...storyline.characters.map((character) =>
          [
            `- ${character.name}${character.isSelf ? ' (you)' : ''} [${character.id}] — ${character.role}`,
            character.description ? `  ${character.description}` : null,
            character.voice?.tone ? `  Voice: ${character.voice.tone}` : null,
            character.voice?.quirks?.length
              ? `  Quirks: ${character.voice.quirks.join(', ')}`
              : null,
            // What they are after is what lets them start something rather than
            // only answer. Shown for whoever is currently in play.
            character.want && stage.has(character.id) ? `  Wants: ${character.want}` : null,
            character.avoids && stage.has(character.id) ? `  Avoids: ${character.avoids}` : null,
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
        ...(storyline.timeline.length
          ? ['## What has happened', ...renderTimeline(storyline.timeline), '']
          : ['## What has happened', 'Nothing yet. This is the very beginning.', '']),
        // Per-character background was assembled and then dropped on the floor.
        // Rendered under the same heading rather than a new one, because the rule
        // that governs this material — "Background is what you know, not what you
        // state" — keys on the word Background, and material the model has no
        // instruction about is material it is most likely to blurt.
        //
        // Iterated by cast, not by Object.entries: the order is then stable, and
        // an entry about somebody no longer cast disappears instead of rendering
        // as "someone".
        ...(() => {
          const lines = [
            ...storyline.background.storylineLevel.map((b) => `- ${b}`),
            ...storyline.characters.flatMap((character) =>
              (storyline.background.byCharacterId[character.id] ?? []).map(
                (entry) => `- ${character.name}: ${entry}`
              )
            ),
          ];
          return lines.length ? ['## Background (known, not stated)', ...lines, ''] : [];
        })(),
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
                [
                  `- ${turn.headline ? `${turn.headline} ` : ''}${turn.narrativeContent}`,
                  ...turn.surfaceLines.map((line) => `  ${line}`),
                  turn.selectedChoiceLabel
                    ? `  You chose: ${turn.selectedChoiceLabel}`
                    : '  (unanswered)',
                ].join('\n')
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
    };
  },
};

/**
 * Whose wants are worth spending prompt on.
 *
 * The protagonist always, plus anyone who took part in the beats the reader can
 * currently see. A twelve-person group chat rendering two lines each is
 * unconditional growth on a prompt that already carries a timeline and the whole
 * playthrough — and a character who has not been near the story for twenty beats
 * is not who the next one is about.
 *
 * Everyone stays in `## Cast` regardless; this governs only the extra lines.
 */
const RECENT_BEATS_ON_STAGE = 4;

function onStage(storyline: StorylineContext): Set<string> {
  const recent = storyline.timeline.slice(-RECENT_BEATS_ON_STAGE);
  const ids = new Set(recent.flatMap((beat) => beat.participantCharacterIds));
  for (const character of storyline.characters) {
    if (character.isSelf) ids.add(character.id);
  }
  return ids;
}

function nameOf(storyline: StorylineContext, characterId: string): string {
  return storyline.characters.find((c) => c.id === characterId)?.name ?? 'someone';
}
