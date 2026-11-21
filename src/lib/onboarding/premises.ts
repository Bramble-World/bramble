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
 * The first story is a romance, so these are written for an ex or a crush, and
 * each is written twice: an ex and a crush are different stories, not one story
 * with a different label (players said a crush kept reading as "a long lost ex
 * who still desperately wants you", 2026-11-21). For an ex, you were together,
 * it ended, and something was left unsaid; they may still want you. For a crush,
 * you have never been together, nothing has been said, and you don't know how
 * they feel: the story is finding out, so what they want at 1:47 AM stays open
 * (a confession, or just needing you as a friend tonight). The other
 * relationships (only older builds can still send them) keep the wedding, whose
 * setup was written for every relationship.
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

const isCrush = (naming: Naming) => naming.relationship === 'crush';

/** "Your ex" or "Your crush", to start a description with. */
const who = (naming: Naming) => (isCrush(naming) ? 'Your crush' : 'Your ex');

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
    /** Who you are to each other: a past for an ex, the present for a crush. */
    between: string;
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
      {
        title: isCrush(naming) ? 'What you are to each other' : 'What you were to each other',
        description: parts.between,
        engagementScore: 6,
      },
      { title: 'Tonight', description: parts.now, engagementScore: 7 },
      { title: 'Two texts at 1:47 AM', description: parts.texts, engagementScore: 9 },
    ],
    context: [parts.context],
  };
}

/** "is" or "are" after a pronoun. */
const be = (naming: Naming) => (naming.pronouns === 'they' ? 'are' : 'is');
/** "has" or "have" after a pronoun. */
const have = (naming: Naming) => (naming.pronouns === 'they' ? 'have' : 'has');

const MOVING_AWAY: Premise = {
  id: 'moving_away',
  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    return {
      headline: `${naming.name} is leaving for good in the morning. And ${p.they} just texted you.`,
      narrative:
        'You read it twice. The flight is in seven hours. You sit up in the dark and the phone lights your hands.',
      choices: [
        { label: 'Text back: "tell me."', reply: 'tell me.' },
        { label: `Call ${naming.name} right now`, reply: null },
        { label: 'Put the phone face down', reply: null },
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
    const shared = {
      title: 'the last night',
      setting: `Your room, the small hours before ${naming.name} moves across the country.`,
      tone: 'urgent, tender, running out of time',
      now: `${naming.name} is moving across the country tomorrow morning. You found out from someone else and didn't say goodbye.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} couldn't leave without telling you something.`,
      context: `${naming.name}'s flight is at 9 AM. Nobody else knows ${p.they} texted you.`,
    };
    if (isCrush(naming)) {
      return setup(naming, {
        ...shared,
        self: {
          description: `Awake at 1:47 AM, hours before ${naming.name} leaves for good.`,
          want: `to hear what ${naming.name} couldn't leave without saying, and whether it's about you`,
          avoids: `saying how you feel before ${naming.name} is gone`,
        },
        named: {
          description: `${who(naming)}, moving across the country on a 9 AM flight, texting you instead of sleeping.`,
          want: `to say something to you before ${p.they} ${be(naming)} gone: maybe how ${p.they} feel${naming.pronouns === 'they' ? '' : 's'}, maybe only goodbye to a friend, and ${p.they} ${have(naming)} not said which`,
          avoids: `saying ${p.they} might not want to go`,
        },
        baseline: {
          closeness: 'good friends, never more',
          tension: 'a goodbye neither of you has said, and a feeling you never told',
        },
        between: `${naming.name} is your crush. You have liked ${p.them} for a long time and never said so, and you have never been together. You don't know if ${p.they} feel${naming.pronouns === 'they' ? '' : 's'} the same.`,
      });
    }
    return setup(naming, {
      ...shared,
      self: {
        description: `Awake at 1:47 AM, hours before ${naming.name} leaves for good.`,
        want: `to hear what ${naming.name} couldn't leave without saying`,
        avoids: 'asking them to stay',
      },
      named: {
        description: `${who(naming)}, moving across the country on a 9 AM flight, texting you instead of sleeping.`,
        want: `to tell you the thing ${p.they} never said before ${p.they} ${be(naming)} gone`,
        avoids: `saying ${p.they} might not want to go`,
      },
      baseline: {
        closeness: 'close once, then careful',
        tension: 'a goodbye neither of you has said',
      },
      between: `${naming.name} is your ex. It ended quietly, before either of you was ready, and you never talked about why.`,
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
        { label: 'Text back: "are you ok?"', reply: 'are you ok?' },
        { label: `Call ${naming.name} right now`, reply: null },
        { label: 'Wait to see what else comes', reply: null },
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
    const shared = {
      title: 'the first person',
      setting: `Your room, the small hours of the night ${naming.name}'s relationship ended.`,
      tone: 'raw, hopeful, unsure what it means',
      now: `${naming.name} ended things with ${p.their} partner about an hour ago. Nobody knows yet.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} just ended it and you were the first person ${p.they} wanted to tell.`,
    };
    if (isCrush(naming)) {
      return setup(naming, {
        ...shared,
        self: {
          description: `Awake at 1:47 AM, holding a phone that just told you ${naming.name} is single.`,
          want: `to know why ${naming.name} came to you first`,
          avoids: 'hoping too fast, or letting it show',
        },
        named: {
          description: `${who(naming)}, an hour out of a relationship with someone else, texting you before anyone else.`,
          want: `someone to be there tonight; whether that is a friend or something more, ${p.they} ${have(naming)} not said, maybe not even to ${p.them}self`,
          avoids: `admitting why ${p.they} ended it`,
        },
        baseline: {
          closeness: 'friends, warm, with a line you both stay behind',
          tension: 'a feeling you have never said, and now nothing in its way',
        },
        between: `${naming.name} is your crush, and was with someone else the whole time you have liked ${p.them}. You have never been together and never said how you feel. You don't know if ${p.they} ever thought of you that way.`,
        context: `${naming.name}'s relationship ended tonight. ${capitalised(p.their)} friends don't know yet.`,
      });
    }
    return setup(naming, {
      ...shared,
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
      between: `${naming.name} is your ex. ${capitalised(p.they)} moved on fast, and you told everyone you were fine with it.`,
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
        { label: 'Text back: "why didn\'t you?"', reply: "why didn't you?" },
        { label: `Call ${naming.name} right now`, reply: null },
        { label: 'Text back: "i didn\'t see you"', reply: "i didn't see you" },
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
    const shared = {
      title: 'across the room',
      setting: `Your room after a party, the small hours of a Saturday.`,
      tone: 'charged, a little jealous, full of what-ifs',
      now: `You were at a party tonight. ${naming.name} was there too, saw you laughing with someone, and left without coming over.`,
      texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} saw you tonight, you looked happy, and ${p.they} should have come over.`,
      context: `You didn't see ${naming.name} at the party. You don't know who ${p.they} thinks you were with.`,
    };
    if (isCrush(naming)) {
      return setup(naming, {
        ...shared,
        self: {
          description: `Home from a party, awake at 1:47 AM, finding out ${naming.name} was there too.`,
          want: `to know why ${naming.name} didn't come over, and what it means that ${p.they} texted now`,
          avoids: 'showing how much it matters',
        },
        named: {
          description: `${who(naming)}, who watched you across a party tonight and left without saying hi.`,
          want: `to talk to you tonight, though ${p.they} ${have(naming)} not said what about`,
          avoids: `saying why ${p.they} left without coming over`,
        },
        baseline: {
          closeness: 'friends, close but never close enough to say it',
          tension: 'a feeling you have never said, and no idea if it goes both ways',
        },
        between: `${naming.name} is your crush. You've been friends, close but never close enough to say it, and you have never been together. You don't know if ${p.they} feel${naming.pronouns === 'they' ? '' : 's'} the same.`,
      });
    }
    return setup(naming, {
      ...shared,
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
      between: `${naming.name} is your ex. You haven't really talked since it ended, only polite likes on each other's posts.`,
    });
  },
};

/**
 * For an ex, the photo from the best night of them together. A crush has no such
 * night, so theirs is a group photo from a trip where the two of them are the
 * only ones not looking at the camera: something to wonder about, not remember.
 */
const FOUND_THE_PHOTO: Premise = {
  id: 'found_the_photo',
  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    if (isCrush(naming)) {
      return {
        headline: `${naming.name} found an old photo with you in it. And ${p.they} just texted you.`,
        narrative:
          'You know exactly which photo. Everyone else is smiling at the camera, and you never worked out what the two of you were looking at.',
        choices: [
          { label: 'Text back: "send it to me."', reply: 'send it to me.' },
          { label: `Call ${naming.name} right now`, reply: null },
          { label: 'Text back: "what were we looking at?"', reply: 'what were we looking at?' },
        ],
        surface: {
          ...PHONE_TIME,
          texts: [
            "i was cleaning my room and found the group photo from the lake trip. we're the only two not looking at the camera",
            'hey. are you up?',
          ],
        },
      };
    }
    return {
      headline: `${naming.name} found a photo of the two of you. And ${p.they} just texted you.`,
      narrative:
        "You know exactly which photo. You haven't looked at it in a year, and you could still describe it.",
      choices: [
        { label: 'Text back: "i remember."', reply: 'i remember.' },
        { label: `Call ${naming.name} right now`, reply: null },
        { label: 'Text back: "what photo?"', reply: 'what photo?' },
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
    if (isCrush(naming)) {
      return setup(naming, {
        title: 'the lake photo',
        setting: 'Your room, the small hours, a year after a group trip to the lake.',
        tone: 'soft, curious, full of what-ifs',
        self: {
          description: `Awake at 1:47 AM, thinking about a group photo from the lake with ${naming.name} in it.`,
          want: `to know why ${naming.name} texted you about that photo, tonight`,
          avoids: 'admitting you know the photo by heart',
        },
        named: {
          description: `${who(naming)}, up late, holding a group photo from a lake trip a year ago with the two of you in it.`,
          want: `to talk to you about it, though whether it's about you or just a night of looking back, ${p.they} ${have(naming)} not said`,
          avoids: `saying why that photo made ${p.them} text you`,
        },
        baseline: {
          closeness: 'friends, easy together, never more',
          tension: 'a feeling you have never said, and no idea if it goes both ways',
        },
        between: `${naming.name} is your crush. You've been friends since a group trip to the lake a year ago, you have liked ${p.them} for most of it, and you have never been together or said so. You don't know if ${p.they} feel${naming.pronouns === 'they' ? '' : 's'} the same.`,
        now: `${naming.name} was cleaning ${p.their} room tonight and found the group photo from the lake trip, where the two of you are the only ones not looking at the camera.`,
        texts: `${naming.name} texted you at 1:47 AM, hey, are you up, and then that ${p.they} found the group photo from the lake trip and that you two are the only ones not looking at the camera.`,
        context: `You have the same photo saved on your phone. ${naming.name} doesn't know that.`,
      });
    }
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
      between: `${naming.name} is your ex. That night on the roof was the best part of you two, a year before it ended.`,
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
