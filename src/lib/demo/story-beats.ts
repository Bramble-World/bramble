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

/**
 * One email in a thread. Only the email surface renders these; the persona's
 * display name and portrait come from the scenario, so a beat only carries what
 * changes from message to message.
 */
export type StoryEmail = {
  subject: string
  fromAddress: string
  /** Display strings, Gmail-style — the player is just "me". */
  to: string[]
  cc?: string[]
  sentAt: string
  /** One string per paragraph. */
  body: string[]
  attachments?: string[]
}

export type StoryBeat = {
  /** Sets the scene — "Your phone lights up." */
  narration: string
  /**
   * What they sent. The messages surface renders this as the notification; both
   * surfaces use it as the pull-quote in the story column, which is why an
   * email beat sets it to the line worth quoting rather than the whole body.
   */
  incomingMessage: string | null
  /** The full email, on scenarios whose surface is "email". */
  incomingEmail?: StoryEmail
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


// MARK: Ray — email

const FROM_RAY = "raymond.osei@icloud.com"

const theLongEmail: StoryBeat[] = [
  {
    narration: "It landed at 2:14 in the morning. You have read it four times since.",
    incomingMessage: "I am not writing to ask you for anything. I want to be clear about that first.",
    incomingEmail: {
      subject: "Some things I should have said",
      fromAddress: FROM_RAY,
      to: ["me"],
      sentAt: "2:14 AM",
      body: [
        "I am not writing to ask you for anything. I want to be clear about that first, because I know how this looks arriving at this hour after this long.",
        "I have started this email a number of times over the last four years. Each time I read it back it sounded like a man explaining himself, and I did not want to send you that.",
        "I do not have a version that sounds better. So this is the one I am sending.",
        "Your mother would have written it much sooner.",
      ],
    },
    reaction: "Four years, and he still opens with a disclaimer.",
    choices: choices(["Reply before you lose your nerve", "Read it a fifth time", "Ask him why now"]),
  },
  {
    narration: "The reply comes back the same afternoon. Much shorter.",
    incomingMessage:
      "I did not know how to be at that funeral and be your father on the same day. So I was neither.",
    incomingEmail: {
      subject: "Re: Some things I should have said",
      fromAddress: FROM_RAY,
      to: ["me"],
      sentAt: "1:47 PM",
      body: [
        "Why now is a fair question and I do not have a clean answer for it.",
        "I did not know how to be at that funeral and be your father on the same day. So I was neither, and then it had been a year, and then it had been four.",
        "That is not an excuse. It is only the actual sequence.",
      ],
    },
    reaction: "It is the first honest sentence he has ever put in writing to you.",
    choices: choices([
      "Tell him what that day was like",
      "Tell him four years is a long time",
      "Ask what he wants from this",
    ]),
  },
  {
    narration: "Three days of nothing. Then, at a reasonable hour for once:",
    incomingMessage: "I am not asking to be forgiven. I am asking for a Tuesday.",
    incomingEmail: {
      subject: "Re: Some things I should have said",
      fromAddress: FROM_RAY,
      to: ["me"],
      sentAt: "10:31 AM",
      body: [
        "I have read your last message more times than is dignified.",
        "I am not asking to be forgiven. I know that is not a thing which gets handed over by email.",
        "I am asking for a Tuesday. Any Tuesday. Coffee, an hour, somewhere public enough that either of us can leave.",
      ],
    },
    reaction: "He picked the smallest thing he could think to ask for.",
    choices: choices(["Say yes", "Say not yet", "Name a condition"]),
  },
  {
    narration: "A one-line reply, and an attachment.",
    incomingMessage: "Tuesday. It is refundable, so please do not feel you have spent anything by saying yes.",
    incomingEmail: {
      subject: "Re: Some things I should have said",
      fromAddress: FROM_RAY,
      to: ["me"],
      sentAt: "10:58 AM",
      body: [
        "Tuesday. It is refundable, so please do not feel you have spent anything by saying yes.",
      ],
      attachments: ["BA1476-tue-0810.pdf"],
    },
    reaction: "He booked the flight before he asked.",
    choices: [],
  },
]

// MARK: Priya — email

const FROM_PRIYA = "p.raman@northgate.co"
const THREAD = "Re: Q3 launch — status"

const replyAll: StoryBeat[] = [
  {
    narration: "It went out to eleven people. One of them is your skip-level.",
    incomingMessage:
      "The slip traces back to the copy handoff, which sat on Blossom's side of the fence for most of last week.",
    incomingEmail: {
      subject: THREAD,
      fromAddress: FROM_PRIYA,
      to: ["q3-launch@northgate.co"],
      cc: ["j.whitfield@northgate.co", "+9 others"],
      sentAt: "4:58 PM",
      body: [
        "Adding a quick note here just to close the loop for everyone's visibility.",
        "The slip on the launch date traces back to the copy handoff, which sat on Blossom's side of the fence for most of last week. Engineering were ready on time and I don't want that to get lost.",
        "Nothing to action over the weekend — flagging now so that Monday's review can be a short meeting.",
        "Have great weekends all!",
      ],
    },
    reaction: "It is 4:58 on a Friday and yours is the only name in the sentence.",
    choices: choices([
      "Reply all with the timeline",
      "Reply to Priya only",
      "Leave it until Monday",
    ]),
  },
  {
    narration: "Ninety seconds later, a second email. This one has only your name in the To field.",
    incomingMessage: "hey — I don't think that landed the way I meant it to. long week.",
    incomingEmail: {
      subject: THREAD,
      fromAddress: FROM_PRIYA,
      to: ["me"],
      sentAt: "5:00 PM",
      body: [
        "hey — I don't think that landed the way I meant it to.",
        "It's been a long week and Whitfield has been on me about the date since Tuesday. I wasn't trying to make it about you.",
        "Drink next week? My shout.",
      ],
    },
    reaction: "Two registers, one person, ninety seconds apart.",
    choices: choices([
      "Tell her it's fine",
      "Point out the thread is still sitting there",
      "Ask her to correct it publicly",
    ]),
  },
  {
    narration: "Eleven minutes, which for Priya is a very long time.",
    incomingMessage:
      "You're right, and I'll fix it. I'd rather do it Monday though — nobody is reading that thread at 5pm on a Friday.",
    incomingEmail: {
      subject: THREAD,
      fromAddress: FROM_PRIYA,
      to: ["me"],
      sentAt: "5:11 PM",
      body: [
        "You're right, and I'll fix it.",
        "I'd rather do it Monday morning though — nobody is reading that thread at 5pm on a Friday, and a correction tonight looks like we spent the weekend arguing about it.",
        "Is that ok? I'm not trying to bury it.",
      ],
    },
    reaction: "Reasonable. Also exactly what you would write if you were hoping it blew over.",
    choices: choices(["Take Monday", "Ask her to send it tonight", "Say you'll send your own"]),
  },
  {
    narration: "Monday, 9:04. Same subject line, same eleven recipients.",
    incomingMessage:
      "The copy handoff was delayed on my side, not Blossom's. It was flagged to me twice and I missed both.",
    incomingEmail: {
      subject: THREAD,
      fromAddress: FROM_PRIYA,
      to: ["q3-launch@northgate.co"],
      cc: ["j.whitfield@northgate.co", "+9 others"],
      sentAt: "9:04 AM",
      body: [
        "Correcting my note from Friday ahead of this morning's review.",
        "The copy handoff was delayed on my side, not Blossom's. It was flagged to me twice — on the 12th and again on the 14th — and I missed both. Full timeline attached.",
        "Apologies for the noise on a Friday evening.",
      ],
      attachments: ["q3-copy-handoff-timeline.pdf"],
    },
    reaction: "She used your name again. Differently.",
    choices: [],
  },
]

const SCRIPTS: Record<string, StoryBeat[]> = {
  "unsent-apology": unsentApology,
  "three-days-of-maybe": threeDaysOfMaybe,
  "operation-birthday": operationBirthday,
  "the-ask": theAsk,
  "slow-fade": slowFade,
  "the-long-email": theLongEmail,
  "reply-all": replyAll,
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
