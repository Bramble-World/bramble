// One turn of the story: what arrives, how it lands, and what you can do.
//
// Every beat is written by hand. The real app generates these from the model;
// the demo runs a fixed script so there is no network, no key, and nothing that
// can fail in front of an audience.
//
// Each scenario is a linear chain — any choice advances to the next beat — so
// the persona's replies are written to land regardless of which option was
// taken. The last beat in each chain has no choices and ends the chapter.

export type StoryChoice = {
  letter: string
  text: string
  /** The escape hatch — the player writes their own reply instead of picking. */
  isFreeform: boolean
}

export type StoryBeat = {
  /** Sets the scene — "Your phone lights up." */
  narration: string
  /** What they sent, shown on the phone and in the transcript. */
  incomingMessage: string | null
  /** The pause before the decision — "You stare at it for a few seconds." */
  reaction: string
  /** Empty means the chapter is over. */
  choices: StoryChoice[]
}

export const FREEFORM_CHOICE: StoryChoice = {
  letter: "D",
  text: "Do something else",
  isFreeform: true,
}

const LETTERS = ["A", "B", "C"]

function choices(options: string[]): StoryChoice[] {
  return [
    ...options.slice(0, 3).map((text, index) => ({
      letter: LETTERS[index],
      text,
      isFreeform: false,
    })),
    FREEFORM_CHOICE,
  ]
}

const unsentApology: StoryBeat[] = [
  {
    narration: "Your phone lights up.",
    incomingMessage: "you up?",
    reaction: "Three days of nothing, and now this.",
    choices: choices([
      "Reply immediately",
      "Leave her on read",
      "Say something you didn't say in the original timeline",
    ]),
  },
  {
    narration: "The typing indicator starts and stops twice.",
    incomingMessage: "i wasn't going to text you. i've been trying not to for three days",
    reaction: "She's telling the truth, which is somehow worse.",
    choices: choices(["Ask what changed", "Admit you've been waiting", "Tell her you're tired of this"]),
  },
  {
    narration: "A long pause, then two messages at once.",
    incomingMessage: "i don't want to do the thing where we're careful with each other",
    reaction: "It's the closest she's come to asking for something.",
    choices: choices(["Say you don't either", "Ask what she does want", "Keep it light"]),
  },
  {
    narration: "The three dots appear, and stay.",
    incomingMessage: "ok. then come over.",
    reaction: "Whatever happens next doesn't happen over text.",
    choices: [],
  },
]

const threeDaysOfMaybe: StoryBeat[] = [
  {
    narration: "Eight days later, the thread stirs.",
    incomingMessage: "ok so I've been thinking about that maybe",
    reaction: "You read it twice to be sure it says what you think.",
    choices: choices(["Ask what they decided", "Play it cool", "Tell them what you actually meant"]),
  },
  {
    narration: "They're typing before you've put the phone down.",
    incomingMessage: "I'm not good at this part. the saying-it-out-loud part 😅",
    reaction: "An admission, dressed up as a joke.",
    choices: choices(["Say it for them", "Wait them out", "Make it easy"]),
  },
  {
    narration: "The emoji doesn't come this time.",
    incomingMessage: "fine. yes. it was an invitation. it's been an invitation for a month",
    reaction: "Well.",
    choices: choices(["Say yes", "Ask why they waited", "Tease them about it"]),
  },
  {
    narration: "A reply, almost instantly.",
    incomingMessage: "friday? the ramen place? like an actual thing?",
    reaction: "You type yes before you can talk yourself out of it.",
    choices: [],
  },
]

const operationBirthday: StoryBeat[] = [
  {
    narration: "Your phone buzzes twice in a row.",
    incomingMessage: "ok don't panic but rosa ordered TWO cakes",
    reaction: "Saturday is in four days and nothing is booked.",
    choices: choices([
      "Take over the planning",
      "Ask what she's committed you to",
      "Tell her to cancel one cake",
    ]),
  },
  {
    narration: "Three messages arrive before you finish the first.",
    incomingMessage: "also I may have told 22 people. maybe 24",
    reaction: "The guest list has doubled since Tuesday.",
    choices: choices(["Find a bigger place", "Cut the list", "Ask if mom would even want this"]),
  },
  {
    narration: "The typing stops for a while.",
    incomingMessage: "wait. do you think she'd hate this?",
    reaction: "It's the first time she's asked instead of announced.",
    choices: choices(["Tell her mom will love it", "Be honest", "Ask what Dani actually wants"]),
  },
  {
    narration: "A single message, unusually short.",
    incomingMessage: "ok. smaller. just us and rosa and the two cakes",
    reaction: "It's the best plan either of you has had all week.",
    choices: [],
  },
]

const theAsk: StoryBeat[] = [
  {
    narration: "A notification, two days after you asked.",
    incomingMessage: "Do you have ten minutes this afternoon?",
    reaction: "No indication of which way this goes.",
    choices: choices(["Say yes and wait", "Ask what it's about first", "Make your case before the meeting"]),
  },
  {
    narration: "The reply takes eleven minutes.",
    incomingMessage: "It's about your ask. I'd rather not do it over text.",
    reaction: "Which could mean anything, and he knows it.",
    choices: choices(["Push for a hint", "Agree and leave it", "Send the numbers anyway"]),
  },
  {
    narration: "Then, unprompted:",
    incomingMessage: "For what it's worth, I put it forward on Monday.",
    reaction: "He led with the part he didn't have to say.",
    choices: choices(["Thank him", "Ask what happens now", "Ask what it'll take"]),
  },
  {
    narration: "One more, as you're locking the screen.",
    incomingMessage: "Finance pushed back. I pushed harder. 2pm.",
    reaction: "You read it three times on the way to the meeting.",
    choices: [],
  },
]

const slowFade: StoryBeat[] = [
  {
    narration: "Three weeks of silence, then this.",
    incomingMessage: "hey stranger. sorry, I'm the worst",
    reaction: "The same apology he's made four times this year.",
    choices: choices(["Let him off the hook", "Say you've missed him", "Name what's actually happening"]),
  },
  {
    narration: "He starts typing straight away.",
    incomingMessage: "I know. I keep meaning to and then it's been another month",
    reaction: "He isn't defending it, which is new.",
    choices: choices(["Ask what's going on with him", "Tell him it's fine", "Tell him it isn't fine"]),
  },
  {
    narration: "This reply takes a while.",
    incomingMessage: "honestly things have been bad and I didn't want to bring that into your life",
    reaction: "Ten years, and he thought that was the kinder option.",
    choices: choices([
      "Tell him that's not how this works",
      "Ask him to tell you",
      "Say you'd have wanted to know",
    ]),
  },
  {
    narration: "The reply is immediate.",
    incomingMessage: "can I call you? like now, not 'sometime'",
    reaction: "Your phone is already ringing.",
    choices: [],
  },
]

const SCRIPTS: Record<string, StoryBeat[]> = {
  "unsent-apology": unsentApology,
  "three-days-of-maybe": threeDaysOfMaybe,
  "operation-birthday": operationBirthday,
  "the-ask": theAsk,
  "slow-fade": slowFade,
}

/** The full chain for a scenario, opening beat first. */
export function sequenceFor(scenarioId: string, fallbackMessage?: string): StoryBeat[] {
  return (
    SCRIPTS[scenarioId] ?? [
      {
        narration: "Your phone lights up.",
        incomingMessage: fallbackMessage ?? null,
        reaction: "You stare at it for a few seconds.",
        choices: [],
      },
    ]
  )
}
