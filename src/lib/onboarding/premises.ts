import type { Naming, Opening, Pronouns, ScriptedBeat, StorySetup } from './openings';

/**
 * Why the person is texting at 1:47 AM: the premise behind the 1:47 AM opening.
 *
 * Every player sees the same first screen ("hey. are you up?", bundled in the
 * app), and until 2026-11-19 every story behind it was the same wedding eve, so
 * two players' first minutes read alike (the user's call: "it seems
 * preprogrammed"). Now the server picks one premise per guest when the story is
 * written, and each has its own scripted beat 1 (instant, no model call) and its
 * own setup for the model to continue from.
 *
 * The first story is a romance, so these are written for an ex or a crush. The
 * other relationships (only older builds can still send them) keep the wedding,
 * whose setup was written for every relationship.
 */
export type Premise = {
  /** Stable and snake_case: sent to analytics as `premise`. */
  id: PremiseId;
  beat1: (naming: Naming) => ScriptedBeat;
  setup: (naming: Naming) => StorySetup;
};

export const PREMISE_IDS = [
  'wedding',
  'moving_away',
  'just_broke_up',
  'saw_you_tonight',
  'found_the_photo',
] as const;
export type PremiseId = (typeof PREMISE_IDS)[number];

const FORMS: Record<Pronouns, { they: string; them: string; their: string; theyre: string }> = {
  he: { they: 'he', them: 'him', their: 'his', theyre: "he's" },
  she: { they: 'she', them: 'her', their: 'her', theyre: "she's" },
  they: { they: 'they', them: 'them', their: 'their', theyre: "they're" },
};

const PHONE_TIME = { clockTime: '1:48', dateLabel: 'Saturday, June 14' };

/** "your ex" or "your crush", as the setup describes them. */
const who = (naming: Naming) => (naming.relationship === 'crush' ? 'your crush' : 'your ex');

/** The past between you, one line per relationship, so beat 2 knows what's at stake. */
function history(naming: Naming, ex: string, crush: string): string {
  return naming.relationship === 'crush' ? crush : ex;
}

/** A setup with the parts every premise shares filled in. */
function setup(
  naming: Naming,
  parts: {
    title: string;
    setting: string;
    tone: string;
    self: StorySetup['self'];
    named: StorySetup['named'];
    baseline: StorySetup['baseline'];
    past: string;
    now: string;
    texts: string;
    context: string;
  }
): StorySetup {
  return {
    storyline: { title: parts.title, setting: parts.setting, tone: parts.tone },
    self: parts.self,
    named: parts.named,
    baseline: parts.baseline,
    events: [
      { title: 'What you were to each other', description: parts.past, engagementScore: 6 },
      { title: 'Tonight', description: parts.now, engagementScore: 7 },
      { title: 'Two texts at 1:47 AM', description: parts.texts, engagementScore: 9 },
    ],
    context: [parts.context],
  };
}

const MOVING_AWAY: Premise = {
  id: 'moving_away',
  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    return {
      headline: `${naming.name} is leaving for good in the morning. And ${p.they} just texted you.`,
      narrative:
        'You read it twice. The flight is in seven hours. You sit up in the dark and the phone lights your hands.',
      choices: [
        'Text back: "tell me."',
        `Call ${naming.name} right now`,
        'Put the phone face down',
      ],
      surface: {
        ...PHONE_TIME,
        texts: [
          "my flight's at 9. i couldn't leave without telling you something",
          'hey. are you up?',
        ],
      },
    };
  },
  setup: (naming) => {
    const p = FORMS[naming.pronouns];
    return setup(naming, {
      title: 'the last night',
      setting: `Your room, the small hours before ${naming.name} moves across the country.`,
      tone: 'urgent, tender, running out of time',
      self: {
        description: `Awake at 1:47 AM, hours before ${naming.name} leaves for good.`,
        want: `to hear what ${naming.name} couldn't leave without saying`,
        avoids: 'asking them to stay',
      },
      named: {
        description: `${who(naming)}, moving across the country on a 9 AM flight, texting you instead of sleeping.`,
        want: `to tell you the thing ${p.they} never said before ${p.they} ${naming.pronouns === 'they' ? 'are' : 'is'} gone`,
        avoids: `saying ${p.they} might not want to go`,
      },
      baseline: {
        closeness: 'close once, then careful',
        tension: 'a goodbye neither of you has said',
      },
      past: history(
        naming,
        `${naming.name} is your ex. It ended quietly, before either of you was ready, and you never talked about why.`,
        `${naming.name} is your crush. You have liked ${p.them} for a long time and never said so.`
      ),
      now: `${naming.name} is moving across the country tomorrow morning. You found out from someone else and didn't say goodbye.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} couldn't leave without telling you something.`,
      context: `${naming.name}'s flight is at 9 AM. Nobody else knows ${p.they} texted you.`,
    });
  },
};

const JUST_BROKE_UP: Premise = {
  id: 'just_broke_up',
  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    return {
      headline: `${naming.name} just ended things with ${p.their} partner. You're the first person ${p.they} told.`,
      narrative:
        'You read it with your heart going faster than it should. Three dots appear, and stay, and stay.',
      choices: [
        'Text back: "are you ok?"',
        `Call ${naming.name} right now`,
        'Wait to see what else comes',
      ],
      surface: {
        ...PHONE_TIME,
        texts: [
          'i just ended it. like an hour ago. you were the first person i wanted to tell',
          'hey. are you up?',
        ],
      },
    };
  },
  setup: (naming) => {
    const p = FORMS[naming.pronouns];
    return setup(naming, {
      title: 'the first person',
      setting: `Your room, the small hours of the night ${naming.name}'s relationship ended.`,
      tone: 'raw, hopeful, unsure what it means',
      self: {
        description: `Awake at 1:47 AM, holding a phone that just told you ${naming.name} is single.`,
        want: `to know why ${naming.name} came to you first`,
        avoids: 'hoping too fast',
      },
      named: {
        description: `${who(naming)}, an hour out of a relationship, texting you before anyone else.`,
        want: `to have you there tonight, and maybe more than tonight`,
        avoids: `admitting why ${p.they} ended it`,
      },
      baseline: {
        closeness: 'warm, with a line you both stay behind',
        tension: "what you are to each other, now that it's possible",
      },
      past: history(
        naming,
        `${naming.name} is your ex. ${capitalised(p.they)} moved on fast, and you told everyone you were fine with it.`,
        `${naming.name} is your crush, and was with someone else the whole time you have liked ${p.them}.`
      ),
      now: `${naming.name} ended things with ${p.their} partner about an hour ago. Nobody knows yet.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} just ended it and you were the first person ${p.they} wanted to tell.`,
      context: `${naming.name}'s breakup happened tonight. ${capitalised(p.their)} friends don't know yet.`,
    });
  },
};

const SAW_YOU_TONIGHT: Premise = {
  id: 'saw_you_tonight',
  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    return {
      headline: `${naming.name} saw you tonight and didn't come over. Now ${p.theyre} texting.`,
      narrative: `You go back over the night: the party, the crowd by the kitchen. You never saw ${p.them}. ${capitalised(p.they)} saw you.`,
      choices: [
        'Text back: "why didn\'t you?"',
        `Call ${naming.name} right now`,
        'Text back: "i didn\'t see you"',
      ],
      surface: {
        ...PHONE_TIME,
        texts: [
          "i saw you tonight. you looked really happy. i didn't come over and i should have",
          'hey. are you up?',
        ],
      },
    };
  },
  setup: (naming) => {
    const p = FORMS[naming.pronouns];
    return setup(naming, {
      title: 'across the room',
      setting: `Your room after a party, the small hours of a Saturday.`,
      tone: 'charged, a little jealous, full of what-ifs',
      self: {
        description: `Home from a party, awake at 1:47 AM, finding out ${naming.name} was there too.`,
        want: `to know what ${naming.name} would have said`,
        avoids: 'showing how much it matters',
      },
      named: {
        description: `${who(naming)}, who watched you across a party tonight and left without saying hi.`,
        want: `to tell you what ${p.they} felt seeing you`,
        avoids: `saying ${p.they} left because it hurt`,
      },
      baseline: { closeness: 'distant lately', tension: 'something seen and not said' },
      past: history(
        naming,
        `${naming.name} is your ex. You haven't really talked since it ended, only polite likes on each other's posts.`,
        `${naming.name} is your crush. You've been close, but never close enough to say it.`
      ),
      now: `You were at a party tonight. ${naming.name} was there too, saw you laughing with someone, and left without coming over.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} saw you tonight, you looked happy, and ${p.they} should have come over.`,
      context: `You didn't see ${naming.name} at the party. You don't know who ${p.they} thinks you were with.`,
    });
  },
};

const FOUND_THE_PHOTO: Premise = {
  id: 'found_the_photo',
  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    return {
      headline: `${naming.name} found a photo of the two of you. And ${p.they} just texted you.`,
      narrative:
        "You know exactly which photo. You haven't looked at it in a year, and you could still describe it.",
      choices: [
        'Text back: "i remember."',
        `Call ${naming.name} right now`,
        'Text back: "what photo?"',
      ],
      surface: {
        ...PHONE_TIME,
        texts: [
          'i was cleaning my room and found the photo from that night on the roof. do you remember?',
          'hey. are you up?',
        ],
      },
    };
  },
  setup: (naming) => {
    const p = FORMS[naming.pronouns];
    return setup(naming, {
      title: 'the night on the roof',
      setting: 'Your room, the small hours, a year after a night you both remember.',
      tone: 'nostalgic, soft, dangerous to say out loud',
      self: {
        description: `Awake at 1:47 AM, pulled back to a night on a roof with ${naming.name}.`,
        want: `to know if that night meant to ${naming.name} what it meant to you`,
        avoids: 'admitting you kept your copy too',
      },
      named: {
        description: `${who(naming)}, up late, holding a photo of the two of you from a year ago.`,
        want: `to find out if you still think about that night`,
        avoids: `saying why ${p.they} kept the photo`,
      },
      baseline: {
        closeness: 'a year of not talking about it',
        tension: 'one night that never got a second',
      },
      past: history(
        naming,
        `${naming.name} is your ex. That night on the roof was the best part of you two, a year before it ended.`,
        `${naming.name} is your crush. One night on a roof a year ago, you almost said it, and didn't.`
      ),
      now: `${naming.name} was cleaning ${p.their} room tonight and found a photo of the two of you on a roof, from a year ago.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} found the photo from that night on the roof and asked if you remember.`,
      context: `You still have the same photo. ${naming.name} doesn't know that.`,
    });
  },
};

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The premises an ex or a crush can be written into, the wedding first. */
export function romanticPremises(opening: Opening): readonly Premise[] {
  const wedding: Premise = { id: 'wedding', beat1: opening.beat1, setup: opening.setup };
  return [wedding, MOVING_AWAY, JUST_BROKE_UP, SAW_YOU_TONIGHT, FOUND_THE_PHOTO];
}

/**
 * The premise a guest's story is written from. Picked once, when the story is
 * written (one story per guest), and deterministic in the guest's id, so a
 * retried request writes the same one. An even split, so `premise` in analytics
 * says which reads best.
 */
export function choosePremise(opening: Opening, userId: string, naming: Naming): Premise {
  const premises = romanticPremises(opening);
  if (naming.relationship !== 'ex' && naming.relationship !== 'crush') return premises[0];
  let hash = 7;
  for (const char of userId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return premises[hash % premises.length];
}
