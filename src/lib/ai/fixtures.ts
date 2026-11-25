import { FakeGenerator } from './generator.fake';
import { turnPrompt } from './prompts/turn.prompt';
import { consequencePrompt } from './prompts/consequence.prompt';
import { shortId } from './prompts/short-ids';
import { extractionPrompt } from './prompts/extraction.prompt';
import { arcPrompt } from './prompts/arc.prompt';
import { checkPrompt, rewritePrompt } from './prompts/pool.prompt';
import { personalCheckPrompt, personalRewritePrompt } from './prompts/personal.prompt';
import { endingPrompt } from './prompts/ending.prompt';
import { MAX_LINK_SITUATIONS, situationsPrompt } from './prompts/situations.prompt';
import { SEED_STORIES } from '@/lib/pool/seeds';

/**
 * Canned output for every prompt, so the loop runs with no key and no spend.
 *
 * These deliberately read ids and orders out of the context they are given
 * rather than inventing them. A fixture returning made-up ids would exercise
 * only the path where the service discards what the model said, and the write
 * path — participants attached, relationship states anchored, a beat slotted
 * into a real gap — would never run at all. The point of playing the loop
 * against the fake is that everything downstream of the model is real.
 *
 * They vary by seed so a session does not read as the same beat four times, but
 * the same input always gives the same output: reproducible, not random.
 */
export function registerFixtures(fake: FakeGenerator): void {
  fake.register(turnPrompt, ({ vars, seed }) => {
    const others = vars.storyline.characters.filter((c) => !c.isSelf);
    const other = others[seed % Math.max(others.length, 1)]?.name ?? 'they';
    const beat = vars.storyline.timeline.at(-1);

    const openings = [
      `The message sits there, unsent. ${other} has not said anything for a while.`,
      `You read it back twice. ${other} is still typing, then stops.`,
      `There is a pause long enough to notice. ${other} is waiting on you.`,
    ];

    // Every other turn arrives as texts, from a met character other than you,
    // so the surface path is exercised end to end. No one to text you, no phone.
    const texter = others[seed % Math.max(others.length, 1)];
    const onPhone = texter !== undefined && seed % 2 === 0;

    // Ends as soon as it may, so a test reaches an ending in the fewest beats
    // the closing window allows.
    const isEnding = vars.phase !== 'open';

    return {
      isEnding,
      headline: onPhone
        ? `${texter.name} just texted you.`
        : other === 'they'
          ? 'Everything has gone quiet.'
          : `${other} has gone quiet.`,
      surfaceKind: onPhone ? ('imessage_notifications' as const) : ('none' as const),
      clockTime: onPhone ? '1:47' : null,
      dateLabel: onPhone ? 'Saturday, June 14' : null,
      notifications: onPhone
        ? [
            { senderCharacterId: shortId(texter.id), text: 'are you up' },
            { senderCharacterId: shortId(texter.id), text: 'i have to tell you something' },
          ]
        : [],
      narrative: [
        openings[seed % openings.length],
        beat ? `After ${beat.title.toLowerCase()}, nothing has quite settled.` : '',
        'You could say the true thing, or the easy one.',
      ]
        .filter(Boolean)
        .join(' '),
      // Pauses whenever it's allowed, so the reply-later path is exercised.
      replyLater: vars.pausesAllowed ? ('soon' as const) : ('none' as const),
      choices: [
        { label: 'Say the true thing', description: 'It will not be taken well.', reply: null },
        // A text back on a phone beat, so the reply path is played too.
        onPhone
          ? { label: 'Text back: "i\'m here"', description: null, reply: "i'm here" }
          : { label: 'Say the easy thing', description: null, reply: null },
        { label: 'Say nothing yet', description: 'Let the silence do the work.', reply: null },
      ].slice(0, isEnding ? 0 : 2 + (seed % 2)),
    };
  });

  fake.register(consequencePrompt, ({ vars, seed }) => {
    // Every third decision changes nothing permanent, which is the realistic
    // shape and the one most likely to be handled wrongly.
    const changesCanon = seed % 3 !== 0;
    const cast = vars.storyline.characters;
    const relationship = vars.storyline.relationships[0];

    if (!changesCanon) {
      return {
        events: [],
        contextEntries: [],
        relationshipStates: [],
      };
    }

    return {
      events: [
        {
          title: 'A different answer',
          description: `You said something you did not say the first time, and it landed.`,
          stakes: 'Whatever was unsaid is now said.',
          // Written back as the model writes them: short handles (short-ids.ts).
          participantCharacterIds: cast.slice(0, 2).map((c) => shortId(c.id)),
          actorCharacterId: shortId(cast.find((c) => !c.isSelf)?.id ?? '') || null,
        },
      ],
      contextEntries: [
        {
          content: 'This has been building for longer than either of them has admitted.',
          characterId: null,
        },
      ],
      relationshipStates: relationship
        ? [
            {
              relationshipId: shortId(relationship.id),
              closeness: 'closer, uncomfortably so',
              tension: 'lower, but not gone',
              powerBalance: null,
            },
          ]
        : [],
    };
  });

  fake.register(extractionPrompt, ({ vars }) => {
    // Names and handles are read off the transcript rather than invented, so the
    // person-resolution path — hash the handle, reuse the row next time — is the
    // real one. A fixture with made-up handles would exercise none of it.
    // By sender, not by thread: in a group chat every message shares one handle,
    // so deriving from it would give every participant the same contact hash and
    // resolve them all to one persons row.
    const others = [...new Set(vars.messages.filter((m) => !m.isFromMe).map((m) => m.sender))];
    const selfName = vars.user.self?.name ?? 'Blossom';
    const otherName = 'Maya';

    return {
      title: 'The Unsent Apology',
      tone: 'wistful and a little raw',
      setting: null,
      arcSummary: 'Started with something said badly, ended with it still unsaid.',
      cast: [
        {
          name: selfName,
          existingPersonId: vars.user.self?.id ?? null,
          sourceHandle: null,
          role: 'protagonist' as const,
          description: null,
          voiceTone: 'direct, then apologetic',
          want: 'to have the thing she said taken back properly',
          avoids: 'saying it plainly in front of anyone else',
        },
        {
          name: otherName,
          existingPersonId: vars.user.persons.find((p) => p.name === otherName)?.id ?? null,
          sourceHandle: others[0] ?? null,
          role: 'supporting' as const,
          description: 'Deflects when cornered.',
          voiceTone: 'clipped, changes the subject',
          // Incompatible with the protagonist's want, which is exactly what the
          // extraction rule asks for: only one of them can have theirs.
          want: 'to get through the week without the subject coming up',
          avoids: null,
        },
      ],
      relationships: [
        {
          betweenNames: [selfName, otherName],
          relationshipType: 'siblings',
          closeness: 'were inseparable',
          tension: 'unspoken',
          powerBalance: null,
        },
      ],
      // Scores are spread deliberately, and deterministically. A fixture that
      // returned one number for every beat would let a ranked read pass while
      // ordering by nothing at all — the tests would be asserting against a
      // single-valued column, which is no order.
      beats: [
        {
          title: 'Where things stood',
          description: 'Something said in front of other people had not been taken back.',
          stakes: 'Whether it gets named at all.',
          occurredAt: vars.messages[0]?.sentAt ?? null,
          participantNames: [selfName, otherName],
          engagementScore: 3,
        },
        {
          title: 'The apology that landed wrong',
          description: 'An apology was offered and waved away before it finished.',
          stakes: null,
          occurredAt: vars.messages.at(-1)?.sentAt ?? null,
          participantNames: [selfName, otherName],
          engagementScore: 9,
        },
      ],
      background: [
        {
          content: 'This is not the first time one of them has changed the subject.',
          aboutName: null,
        },
      ],
      motifs: [
        {
          label: 'the lasagna',
          description: 'Invoked whenever a conversation needs to end.',
          participantNames: [selfName, otherName],
        },
      ],
    };
  });

  fake.register(arcPrompt, ({ vars }) => ({
    arcSummary: `Across ${vars.storyline.timeline.length} beats, what began unsaid is now partly said, and neither of them has decided what that means.`,
  }));

  // A short answer is declined, as the real writer is told to; anything longer
  // becomes a story that shares no words with it — a seed, retitled — so a test
  // can assert nothing from the answer survives.
  fake.register(rewritePrompt, ({ vars, seed }) => {
    if (vars.answer.text.trim().length < 20) {
      return { verdict: 'declined' as const, declineCode: 'too_thin' as const, story: null };
    }
    const seeds = Object.values(SEED_STORIES);
    const base = seeds[seed % seeds.length];
    return {
      verdict: 'story' as const,
      declineCode: null,
      story: { ...base, title: `${base.title} (${vars.answer.question})` },
    };
  });

  // Names the beats the reader actually chose on, so the server's check that a
  // key choice is a real answered turn is exercised; plus one beat that isn't.
  fake.register(endingPrompt, ({ vars }) => {
    const chosen = vars.session.turns
      .map((turn, i) => ({ beat: i + 1, label: turn.selectedChoiceLabel }))
      .filter((turn) => turn.label !== null)
      .slice(0, 2);
    return {
      title: 'the long way home',
      summary: 'you said the true thing in the end. it cost you the easy version of the night.',
      keyChoices: [
        ...chosen.map((turn) => ({
          beat: turn.beat,
          label: `you chose to ${turn.label!.toLowerCase()}`,
        })),
        { beat: 999, label: 'you did something that never happened' },
      ].slice(0, 3),
      storyNights: 1,
    };
  });

  fake.register(checkPrompt, () => ({
    verdict: 'pass' as const,
    rejectCode: null,
    qualityScore: 4,
  }));

  // A seed with the people it was given in place of the seed's own, so a test
  // can see the names kept.
  fake.register(personalRewritePrompt, ({ vars, seed }) => {
    if (vars.context.about.trim().length < 20) {
      return { verdict: 'declined' as const, declineCode: 'too_thin' as const, story: null };
    }
    const seeds = Object.values(SEED_STORIES);
    const base = seeds[seed % seeds.length];
    const cast = vars.context.people.map((person, i) => ({
      ...base.cast[i % base.cast.length],
      name: person.name,
      relationshipType: person.relationship,
    }));
    return {
      verdict: 'story' as const,
      declineCode: null,
      story: { ...base, title: `${base.title} (yours)`, cast },
    };
  });

  // One situation per paragraph of 20 characters or more, about the first
  // capitalised word after its first, so a test can send a note and see which
  // paragraphs became stories and that the name was kept.
  fake.register(situationsPrompt, ({ vars }) => ({
    situations: vars.text
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length >= 20)
      .slice(0, MAX_LINK_SITUATIONS)
      .map((about) => ({
        about,
        people: [
          {
            name:
              about
                .split(/\s+/)
                .slice(1)
                .find((word) => /^[A-Z][a-z]+$/.test(word)) ?? 'Sam',
            relationship: 'friend',
            details: '',
          },
        ],
        you: null,
      })),
  }));

  fake.register(personalCheckPrompt, () => ({
    verdict: 'pass' as const,
    rejectCode: null,
    qualityScore: 4,
  }));
}
