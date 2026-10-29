/**
 * The scripted openings a guest's story can begin with.
 *
 * In code rather than in the database because each one is written, reviewed
 * and shipped like any other copy — and because the first beat has to match the
 * iPhone's own sample turn word for word, which is a property of a release, not
 * of a row someone can edit.
 *
 * An opening is everything the story needs before the model writes a word:
 *
 * - **the first screen** — the phone that buzzes before the reader has named
 *   anyone, so it can say nothing about who is texting;
 * - **beat 1** — headline, narrative, choices and the texts on the lock screen,
 *   with slots for the name and pronouns the reader then chooses;
 * - **the setup** — the storyline, the two characters and a short timeline the
 *   model continues from at beat 2, the way it would continue from an imported
 *   conversation.
 *
 * Only one ships today. `chooseOpening` is the seam for testing more than one:
 * it is deterministic per guest, so a guest who reopens the app sees the same
 * opening they named someone into.
 */

export const RELATIONSHIPS = ['ex', 'old_friend', 'crush', 'boss', 'sibling'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const PRONOUNS = ['he', 'she', 'they'] as const;
export type Pronouns = (typeof PRONOUNS)[number];

/** What the reader chose on the naming screen, after validation. */
export type Naming = {
  name: string;
  relationship: Relationship;
  pronouns: Pronouns;
};

/** The phone on the first screen, before anyone is named. */
export type OpeningPhone = {
  /** The lock screen clock, e.g. "1:47". */
  clockTime: string;
  dateLabel: string;
  /** The one text showing. Its sender is who the reader is about to name. */
  text: string;
  /** The time on the notification itself, e.g. "1:47 am". */
  timeLabel: string;
};

export type ScriptedBeat = {
  headline: string;
  narrative: string;
  choices: string[];
  surface: {
    clockTime: string;
    dateLabel: string;
    /** From the named person, newest first, as the surface stores them. */
    texts: string[];
  };
};

export type StorySetup = {
  storyline: { title: string; setting: string; tone: string };
  self: CharacterSetup;
  named: CharacterSetup;
  /** How the two stand when the story opens. */
  baseline: { closeness: string; tension: string };
  /**
   * The timeline so far, oldest first. Both characters take part in every beat,
   * which is what makes the named person someone the reader has "met" — a
   * surface sender must be, and so must anyone the cast list shows.
   */
  events: { title: string; description: string; engagementScore: number }[];
  /** Background the story implies but never states. */
  context: string[];
};

type CharacterSetup = { description: string; want: string; avoids: string };

export type Opening = {
  /**
   * Stable, and snake_case: it is sent to analytics as `opening_id`, where the
   * allowlist test holds every string value to an enum-shaped token.
   */
  id: string;
  phone: OpeningPhone;
  beat1: (naming: Naming) => ScriptedBeat;
  setup: (naming: Naming) => StorySetup;
};

/** Pronoun forms, for slotting into sentences. */
const FORMS: Record<Pronouns, { they: string; them: string; their: string; theyre: string }> = {
  he: { they: 'he', them: 'him', their: 'his', theyre: "he's" },
  she: { they: 'she', them: 'her', their: 'her', theyre: "she's" },
  they: { they: 'they', them: 'them', their: 'their', theyre: "they're" },
};

/**
 * Who the named person is to the reader, as the setup describes them. A sibling
 * becomes a brother or sister when the pronouns say which.
 */
function whoTheyAre(naming: Naming): string {
  switch (naming.relationship) {
    case 'ex':
      return 'your ex';
    case 'old_friend':
      return 'an old friend';
    case 'crush':
      return 'your crush';
    case 'boss':
      return 'your boss';
    case 'sibling':
      return naming.pronouns === 'he'
        ? 'your brother'
        : naming.pronouns === 'she'
          ? 'your sister'
          : 'your sibling';
  }
}

/**
 * Why a wedding-eve text from this person lands the way it does. One line per
 * relationship, so the model starts beat 2 knowing what is actually at stake.
 */
function whatIsUnsaid(naming: Naming): string {
  const p = FORMS[naming.pronouns];
  switch (naming.relationship) {
    case 'ex':
      return `You and ${naming.name} ended it without ever really saying why, and ${p.theyre} marrying someone else tomorrow.`;
    case 'old_friend':
      return `You and ${naming.name} were inseparable once, then drifted, and you only heard about the wedding secondhand.`;
    case 'crush':
      return `You have wanted ${naming.name} for longer than you have admitted to anyone, and tomorrow ${p.theyre} marrying someone else.`;
    case 'boss':
      return `${naming.name} is your boss, the line between you has never been as clear as it should be, and ${p.theyre} getting married tomorrow.`;
    case 'sibling':
      return `You and ${naming.name} have not been close since a fight neither of you will name, and ${p.their} wedding is tomorrow.`;
  }
}

/** Upper-cases the first letter, for a pronoun that starts a sentence. */
const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The 1:47 AM "hey. are you up?" opening.
 *
 * Beat 1 is the iPhone's bundled sample turn, word for word, with the name and
 * pronouns slotted in. "{Name} is getting married" takes "is" whatever the
 * pronouns, because a name is singular even when "they" is not.
 */
export const ARE_YOU_UP: Opening = {
  id: 'are_you_up',

  phone: {
    clockTime: '1:47',
    dateLabel: 'Saturday, June 14',
    text: 'hey. are you up?',
    timeLabel: '1:47 am',
  },

  beat1: (naming) => {
    const p = FORMS[naming.pronouns];
    return {
      headline: `${naming.name} is getting married tomorrow. And ${p.they} just texted you.`,
      narrative:
        "You stare at the screen until it dims, then tap it awake again. Three dots appear. Then they're gone.",
      choices: [
        'Text back: "i\'m up."',
        `Call ${naming.name} right now`,
        'Leave it on read and try to sleep',
      ],
      surface: {
        clockTime: '1:48',
        dateLabel: 'Saturday, June 14',
        texts: [
          "i know it's late. i'm getting married tomorrow and i need to say something before i do",
          'hey. are you up?',
        ],
      },
    };
  },

  setup: (naming) => {
    const p = FORMS[naming.pronouns];
    const who = whoTheyAre(naming);
    return {
      storyline: {
        title: 'the night before',
        setting: 'Your apartment, the small hours of the night before a wedding.',
        tone: 'tense, intimate, a little reckless',
      },
      self: {
        description: `Awake at 1:47 AM the night before ${naming.name}'s wedding, holding a phone that just lit up.`,
        want: `to know what ${naming.name} needs to say before it is too late to matter`,
        avoids: 'saying out loud what they still feel',
      },
      named: {
        description: `${capitalised(who)}. Getting married tomorrow, and texting you at 1:47 AM instead of sleeping.`,
        want: `to say something to you before the wedding that ${p.they} cannot take back`,
        avoids: `admitting what ${p.they} actually want${naming.pronouns === 'they' ? '' : 's'}`,
      },
      baseline: {
        closeness: 'once close, now careful with each other',
        tension: 'something important was never said',
      },
      events: [
        {
          title: 'What you were to each other',
          description: `${naming.name} is ${who}. ${whatIsUnsaid(naming)}`,
          engagementScore: 6,
        },
        {
          title: 'The wedding',
          description: `${naming.name} is getting married tomorrow. You have the invitation, and you have still not decided whether you are going.`,
          engagementScore: 7,
        },
        {
          title: 'Two texts at 1:47 AM',
          description: `${naming.name} texted you in the middle of the night before the wedding: hey, are you up — and then that ${p.they} needed to say something before ${p.they} got married.`,
          engagementScore: 9,
        },
      ],
      // Pronouns are not repeated here: they live on the person, and the turn
      // prompt renders them for every story that person is in.
      context: [
        `It is the night before ${naming.name}'s wedding. Nobody else knows ${p.they} texted you.`,
      ],
    };
  },
};

/** Every opening that can be served. The first is the default. */
export const OPENINGS: readonly Opening[] = [ARE_YOU_UP];

export function openingById(id: string): Opening | undefined {
  return OPENINGS.find((opening) => opening.id === id);
}

/**
 * Which opening a guest sees.
 *
 * Deterministic in the guest's id, so the same guest always gets the same one
 * — the app may ask again after a relaunch, and switching openings between the
 * first screen and the naming screen would be a story that changes under them.
 * With one opening this is always it; with several it is an even split, which
 * is the simplest thing an A/B test needs.
 */
export function chooseOpening(userId: string): Opening {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return OPENINGS[hash % OPENINGS.length];
}
