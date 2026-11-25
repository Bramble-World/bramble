import { z } from 'zod';
import { shortId } from './short-ids';
import { PromptSpec } from '../prompt';
import { SessionContext, StorylineContext } from '@/lib/services/generation/generation.types';
import { renderTimeline, STAKES_WINDOW } from './timeline';
import { joinLines, PromptLine, steppedBreaks, withBreaks } from './cache';
import { relationshipToReader } from './relationship';
import { SURFACE_KINDS } from '@/lib/surfaces';
import { MAX_NOTIFICATION_CHARS, MAX_NOTIFICATIONS } from '@/lib/surfaces/imessage.surface';
import type { StoryPhase } from '@/lib/services/generation/story-phase';

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
  /** How far through its length the story is; decides whether it may, or must, end. */
  phase: StoryPhase;
  /**
   * On a story whose ending is a fixed beat (the first story's beat 5 or 10), how
   * many beats after this one it comes, over the last few before it; null
   * otherwise. Told to the model so the story builds to its ending instead of
   * stopping on it. See `beatsToEnding`.
   */
  beatsToEnding: number | null;
  /**
   * Whether this beat may end with someone replying later, in real time
   * (`pausesAllowed`). Optional so a caller that never pauses (the lab,
   * scripts) needn't say; absent is false.
   */
  pausesAllowed?: boolean;
};

/**
 * Nullable rather than optional throughout.
 *
 * OpenAI's structured output mode requires every property to be present, and
 * expresses "absent" as null. An `.optional()` field either gets rejected or
 * silently never appears, so the schema says nullable and the caller normalises.
 */
/** How a cast line states someone's pronouns. Shared with the consequence prompt. */
export const PRONOUN_LABELS = { he: 'he/him', she: 'she/her', they: 'they/them' } as const;

const choiceSchema = z.object({
  label: z.string().min(1).describe('A short imperative, under 60 characters.'),
  description: z
    .string()
    .nullable()
    .describe('One clause on what this choice risks. Null if the label says enough.'),
  reply: z
    .string()
    .nullable()
    .describe(
      'The exact text you send if you pick this, in your own texting voice. Null unless the choice is sending a text to someone in the scene.'
    ),
});

export const turnOutputSchema = z.object({
  isEnding: z
    .boolean()
    .describe(
      'True only when this beat ends the story. An ending offers no choices; every other beat offers 2-4.'
    ),
  headline: z
    .string()
    .min(1)
    .describe('The hook: one present-tense sentence to "you" saying what just happened.'),
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
        text: z
          .string()
          .describe(
            'One message, as they would type it. No line breaks — several thoughts are several notifications.'
          ),
      })
    )
    .max(MAX_NOTIFICATIONS)
    .describe('Newest first. Empty unless surfaceKind is imessage_notifications.'),
  // Last, after the texts: streamed, a beat shows its headline and texts while
  // the narrative and the choices are still being written.
  narrative: z
    .string()
    .min(1)
    .describe(
      'What you do or feel now, in second person, 1-3 sentences. Never repeats the headline or the words on a surface. No dialogue attribution.'
    ),
  // After the narrative and before the choices: whether the reply to what the
  // reader answers comes later, in real time (pauses.ts). Allowed only when the
  // prompt says so; otherwise the server ignores it.
  replyLater: z
    .enum(['none', 'soon', 'tonight', 'tomorrow'])
    .describe(
      'Whether the reply to what you answer comes later, in real time. none unless the prompt allows a pause and this beat is a natural one.'
    ),
  // 0..4 in the schema, because structured output has no conditional length.
  // `turnIsUsable` holds the real rule: empty for an ending, 2-4 otherwise.
  choices: z
    .array(choiceSchema)
    .max(4)
    .describe(
      'Distinct options. No option may be a rephrasing of another. Empty only when isEnding is true.'
    ),
});

export type TurnOutput = z.infer<typeof turnOutputSchema>;

/**
 * Whether a generated turn obeys the rules the schema cannot express.
 *
 * An ending has no choices and any other beat has two to four. An ending is
 * refused before the closing window, so a story cannot stop at beat three, and
 * past the cap anything but an ending is refused.
 */
export function turnIsUsable(output: TurnOutput, phase: StoryPhase): boolean {
  if (output.isEnding) return phase !== 'open' && output.choices.length === 0;
  return phase !== 'must_end' && output.choices.length >= 2;
}

export const turnPrompt: PromptSpec<TurnVars, TurnOutput> = {
  name: 'turn.generate',
  stage: 'turn',
  schema: turnOutputSchema,

  render: ({ storyline, session, beyondScript, phase, beatsToEnding, pausesAllowed }) => {
    const stage = onStage(storyline);

    return {
      system: [
        // Source-neutral on purpose: stories come from players' answers to the
        // reborn questions, the team's seeds, and (on the Mac) imported
        // conversations. The setup below is what is true, whichever it was.
        'You write one beat of an interactive story.',
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
        '- A choice that is you texting someone in the scene carries reply: the exact',
        '  words you send, one message, the way you would type it — lowercase, casual,',
        '  in the same register as the texts already in the story. The label still',
        '  says what the choice is. Any other choice (calling, going over, putting the',
        '  phone down, waiting, saying something in person) has reply null. Never',
        '  write a reply for a choice that is not literally sending a text.',
        '',
        'Shape of a beat:',
        '- Write it straight out. The rules here and the story below are all you need;',
        '  there is nothing to work out before you begin.',
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
        `- One notification is ONE message: no line breaks, and under ${MAX_NOTIFICATION_CHARS}`,
        '  characters — the way a single text reads on a lock screen. Someone sending',
        '  three thoughts sends three messages, so write three notifications, not one',
        '  with three lines in it.',
        `- Usually 1 or 2. Use ${MAX_NOTIFICATIONS} only when they are arriving in a burst, one`,
        '  after another, because that is what a burst looks like and what it means.',
        '- Otherwise set surfaceKind to none, clockTime and dateLabel to null, and leave',
        '  notifications empty. Most beats are not texts — do not reach for a phone to',
        '  make a scene feel modern.',
      ].join('\n'),

      ...joinLines([
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
        // Cache-friendly order: OpenAI reuses the start of a request that repeats,
        // so what changes least comes first. The motifs and the history change
        // rarely or only at their end; the background, the cast's wants and the
        // relationships move with consequences; the playthrough grows every beat,
        // and where the story is changes every beat, so it is last.
        ...(storyline.motifs.length
          ? [
              '## Recurring',
              ...storyline.motifs.map(
                (m) => `- ${m.label}${m.description ? `: ${m.description}` : ''}`
              ),
              '',
            ]
          : []),
        //
        // The timeline only grows at its end (consequences land at the playhead,
        // and the playhead only reveals the next beat), and a beat is rendered
        // the same way every time once it is older than the stakes window. So
        // the cache is cut inside it, at steps the next beat will repeat; see
        // cache.ts. Everything after the timeline moves with consequences.
        ...(storyline.timeline.length
          ? [
              '## What has happened',
              ...withBreaks(
                renderTimeline(storyline.timeline),
                steppedBreaks(storyline.timeline.length - STAKES_WINDOW)
              ),
              '',
            ]
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
        '## Cast',
        ...storyline.characters.map((character) =>
          [
            `- ${character.name}${character.isSelf ? ' (you)' : ''} [${shortId(character.id)}] — ${character.role}`,
            // The reader said how to refer to them, so it is not the model's to
            // guess from a name.
            character.pronouns ? `  Pronouns: ${PRONOUN_LABELS[character.pronouns]}` : null,
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
          // The label alone ("(crush)") was read as a costume over the ex story:
          // the reader's own relationships say what they mean, every beat.
          const meaning = relationshipToReader(storyline, relationship);
          return [
            `- ${a} and ${b}${relationship.relationshipType ? ` (${relationship.relationshipType})` : ''}${described ? `: ${described}` : ''}`,
            ...(meaning ? [`  ${meaning}`] : []),
          ].join('\n');
        }),
        '',
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
                  // The words themselves, because the reply on screen is what the
                  // other person read, and the next beat answers it.
                  ...(turn.selectedChoiceReply
                    ? [`  You texted: ${turn.selectedChoiceReply}`]
                    : []),
                ].join('\n')
              ),
              '',
            ]
          : []),
        '## Where the story is',
        ...PHASE_RULES[phase],
        ...(phase === 'open' && beatsToEnding !== null ? buildUpRules(beatsToEnding) : []),
        ...(beyondScript
          ? [
              'The setup this story started from has run out. There is no next',
              'planned event waiting to be told — whatever happens now is something',
              'these people have not done before. Invent it from who they are, and',
              'do not stall: silence and non-reply are not a beat.',
            ]
          : []),
        ...(pausesAllowed ? PAUSE_RULES : ['- replyLater is none.']),
        '',
        phase === 'must_end'
          ? 'Write the ending of this story, following on from the choice just made.'
          : session.turns.length
            ? 'Write the next beat, following on from the choice just made.'
            : 'Write the opening beat of this playthrough.',
      ] satisfies PromptLine[]),
    };
  },
};

/**
 * What the model may do about ending the story, by phase.
 *
 * The model decides when a story lands, within the window `storyPhase` sets.
 * An ending is a beat with no choices; it should feel earned by what the reader
 * chose, not like the story running out.
 */
const ENDING_SHAPE = [
  '- An ending is one beat with isEnding true and no choices. It resolves what',
  '  this story has been about: what the reader wanted, what the others wanted,',
  '  and what the reader chose along the way. Their choices decide how it ends —',
  '  the same story ends differently for someone who chose differently.',
  '- It closes, rather than stopping: the last thing that happens, and what it',
  '  leaves the reader with. No cliffhanger, no "to be continued".',
];

/**
 * When a beat may pause for a reply in real time (pauses.ts). Rendered only
 * when the server allows one; the beat after the answer is then written when
 * the reply is due, and arrives by notification.
 */
const PAUSE_RULES = [
  '- This beat may pause the story: set replyLater when someone here would',
  '  naturally answer later, not now. They say they will get back to you, they',
  '  are going to sleep, the night is ending, or they need time to think.',
  '  soon is within the hour, tonight is a few hours, tomorrow is the next',
  '  morning. The choices are then what you say before they go quiet.',
  '- Most beats do not pause. Never pause mid-conversation just to make the',
  '  reader wait; when in doubt, replyLater is none.',
];

const PHASE_RULES: Record<StoryPhase, string[]> = {
  open: [
    '- Do not resolve the story yet. A beat ends on a decision, not a conclusion.',
    '  isEnding is false and there are 2-4 choices.',
  ],
  closing: [
    '- The story is near its end. Steer toward a resolution. When the beat you',
    '  are writing is the natural place for it to end, end it; until then, keep',
    '  ending on a decision. Do not end it just because you may.',
    ...ENDING_SHAPE,
  ],
  must_end: ['- This beat is the ending of the story. It must end now.', ...ENDING_SHAPE],
};

/**
 * The countdown to a fixed ending, so it lands as an ending rather than the
 * story running out: the beats before it tighten toward it, and the one just
 * before it is the decision it turns on. Still no resolution: these beats end
 * on a choice like any other.
 */
function buildUpRules(left: number): string[] {
  if (left === 1) {
    return [
      '- The next beat is the last one: the story ends there. This is its final',
      '  decision, so make it the one the ending turns on, with everything the story',
      '  has been about riding on it. Do not resolve anything yet.',
    ];
  }
  return [
    `- The story ends ${left} beats after this one, on its own last beat. Build toward`,
    '  it: narrow in on what it has been about, bring back what the reader set in',
    '  motion, and let each choice weigh more than the last. No new threads that',
    '  could not be settled by then. Do not resolve it yet.',
  ];
}

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
