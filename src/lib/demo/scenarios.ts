// Hardcoded stand-ins for what the extraction pipeline will produce.
//
// Everything under lib/demo and components/demo is prototype scaffolding: no
// database, no server, no model calls. The shapes mirror what the extraction
// stage will emit, so the UI is already built against roughly the right object.

/** One message in a seeded conversation — the "real" history above the sync line. */
export type SeedMessage = {
  isFromMe: boolean
  text: string
  /** Display-only. The real app derives this from the message date. */
  timestamp: string
}

/** Palette for the life graph. Muted, translucent, no saturated primaries. */
export type ScenarioAccent = "coral" | "blush" | "violet" | "teal" | "azure"

export const ACCENT_COLOR: Record<ScenarioAccent, string> = {
  coral: "rgb(232, 107, 92)",
  blush: "rgb(224, 115, 133)",
  violet: "rgb(133, 120, 204)",
  teal: "rgb(89, 168, 153)",
  azure: "rgb(107, 148, 217)",
}

/** A playable situation. */
export type Scenario = {
  id: string
  /** What the user picks from the graph. */
  title: string
  /** Who the model plays. */
  personaName: string
  /** Shown under the node in the graph — how this person relates to the user. */
  nodeCaption: string
  /** One line of who they are to the user — feeds the persona prompt. */
  relationship: string
  genre: string
  /** Why this is emotionally live. */
  stakes: string
  /** The open question the story mode resolves. */
  unresolved: string
  /** How long the real conversation has been stalled. */
  silenceDuration: string
  /** Voice notes for the persona prompt — derived from history in the real app. */
  voiceNotes: string
  /** Graph presentation. */
  hubLabel: string
  accent: ScenarioAccent
  /** Small satellite labels hanging off this scenario's hub. */
  leaves: string[]
  portrait: string
  /** The conversation up to the sync point. */
  history: SeedMessage[]
}

const unsentApology: Scenario = {
  id: "unsent-apology",
  title: "The Unsent Apology",
  personaName: "Maya",
  nodeCaption: "long-term ex",
  relationship:
    "Your ex. You were together two years; it ended four months ago and you have kept texting anyway.",
  genre: "Unresolved conflict",
  stakes: "The last conversation ended badly and neither of you has reached out since.",
  unresolved: "Whether there is anything left to repair, or whether this was the actual ending.",
  silenceDuration: "3 days of silence",
  voiceNotes:
    "Types in lowercase. Short lines, often several in a row. Goes quiet or ends the conversation when she feels unheard rather than escalating. Does not accept an apology the first time it is offered.",
  hubLabel: "exes",
  accent: "coral",
  leaves: ["two years", "the last fight", "still unread", "her sister knows"],
  portrait: "/portraits/maya.png",
  history: [
    { isFromMe: false, text: "i just don't think you actually hear me when i'm talking", timestamp: "Tue 11:42 PM" },
    { isFromMe: true, text: "that's not fair. I've been trying", timestamp: "Tue 11:44 PM" },
    { isFromMe: false, text: "trying isn't the same as doing", timestamp: "Tue 11:44 PM" },
    { isFromMe: true, text: "what do you want me to say", timestamp: "Tue 11:47 PM" },
    { isFromMe: false, text: "nothing", timestamp: "Tue 11:48 PM" },
    {
      isFromMe: false,
      text: "that's the problem. you always ask me what to say instead of just saying something",
      timestamp: "Tue 11:48 PM",
    },
    { isFromMe: true, text: "maya", timestamp: "Tue 11:52 PM" },
    { isFromMe: false, text: "i'm going to bed", timestamp: "Tue 11:53 PM" },
  ],
}

const threeDaysOfMaybe: Scenario = {
  id: "three-days-of-maybe",
  title: "Three Days of Maybe",
  personaName: "Jordan",
  nodeCaption: "the maybe",
  relationship: "Someone you have been talking to for a few months. Not dating. Not nothing.",
  genre: "Romantic ambiguity",
  stakes: "You asked something close to a real question and got a maybe. Then the thread went quiet.",
  unresolved: "Whether the maybe meant yes, or was a polite way of not saying no.",
  silenceDuration: "8 days of silence",
  voiceNotes:
    "Warm but evasive. Uses emoji to defuse anything that gets too direct. Answers a serious question with a joke first, then sometimes answers it properly. Genuinely interested but avoids being the one who says it plainly.",
  hubLabel: "almosts",
  accent: "blush",
  leaves: ["the ramen place", "read at 2am", "mutual friends", "never defined"],
  portrait: "/portraits/talia.png",
  history: [
    {
      isFromMe: true,
      text: "that place you mentioned — the ramen one — is it actually good or were you just being polite",
      timestamp: "Mon 9:14 PM",
    },
    { isFromMe: false, text: "it's genuinely good. I'd go again", timestamp: "Mon 9:31 PM" },
    { isFromMe: true, text: "is that an invitation", timestamp: "Mon 9:31 PM" },
    { isFromMe: false, text: "😅", timestamp: "Mon 9:40 PM" },
    { isFromMe: false, text: "maybe", timestamp: "Mon 9:40 PM" },
    { isFromMe: true, text: "I'll take maybe", timestamp: "Mon 9:41 PM" },
  ],
}

const operationBirthday: Scenario = {
  id: "operation-birthday",
  title: "Operation Birthday",
  personaName: "Dani",
  nodeCaption: "younger sister",
  relationship:
    "Your younger sister. Chaotic, decisive, commits both of you to things without asking.",
  genre: "Planning under a deadline",
  stakes: "Your mother's surprise party is Saturday and nothing is actually arranged.",
  unresolved: "Who is doing what, and whether Aunt Rosa's cake situation can be contained.",
  silenceDuration: "Saturday is in 4 days",
  voiceNotes:
    "Fast, funny, slightly unhinged. Sends three messages where one would do. Volunteers you for things. Deflects blame cheerfully. Never apologizes for having already told Aunt Rosa.",
  hubLabel: "family",
  accent: "violet",
  leaves: ["mom's 60th", "aunt rosa", "the cake", "saturday"],
  portrait: "/portraits/naomi.png",
  history: [
    {
      isFromMe: true,
      text: "ok so mom's birthday. are we doing something or are we being terrible children again",
      timestamp: "Yesterday 6:02 PM",
    },
    { isFromMe: false, text: "we're doing something!! I already told aunt rosa", timestamp: "Yesterday 6:03 PM" },
    { isFromMe: true, text: "you WHAT", timestamp: "Yesterday 6:03 PM" },
    { isFromMe: false, text: "she's very excited", timestamp: "Yesterday 6:04 PM" },
    { isFromMe: false, text: "she has already made a cake decision", timestamp: "Yesterday 6:04 PM" },
    { isFromMe: true, text: "dani it's the 14th. that's SATURDAY", timestamp: "Yesterday 6:05 PM" },
    { isFromMe: false, text: "yes", timestamp: "Yesterday 6:06 PM" },
    { isFromMe: false, text: "so we should probably talk", timestamp: "Yesterday 6:06 PM" },
  ],
}

const theAsk: Scenario = {
  id: "the-ask",
  title: "The Ask",
  personaName: "Marcus",
  nodeCaption: "your boss",
  relationship: "Your manager of eighteen months. Fair, direct, hard to read, and genuinely busy.",
  genre: "Professional stakes",
  stakes:
    "You have been doing the senior role for seven months without the title or the salary, and you finally said something.",
  unresolved: "Whether he will actually put it forward, or manage you into waiting another cycle.",
  silenceDuration: "2 days of silence",
  voiceNotes:
    "Professional but not cold. Punctuates properly, unlike everyone else in your phone. Answers in his own time. Never commits to anything in writing that he has not already decided. Responds well to specifics and badly to vagueness.",
  hubLabel: "work",
  accent: "teal",
  leaves: ["7 months acting up", "review cycle", "the headcount freeze", "no title yet"],
  portrait: "/portraits/marcus.png",
  history: [
    {
      isFromMe: true,
      text: "Hey — following up on what I raised on Thursday. Did you get a chance to think about it?",
      timestamp: "Thu 4:12 PM",
    },
    { isFromMe: false, text: "I did. I want to give you a real answer rather than a fast one.", timestamp: "Thu 6:48 PM" },
    { isFromMe: true, text: "That's fair. I just don't want it to slide into next quarter again.", timestamp: "Thu 6:51 PM" },
    { isFromMe: false, text: "Understood. Let me look at where we are on headcount.", timestamp: "Thu 7:20 PM" },
    { isFromMe: true, text: "Appreciate it. I've been covering the role since March.", timestamp: "Thu 7:22 PM" },
    { isFromMe: false, text: "I know you have.", timestamp: "Thu 7:40 PM" },
  ],
}

const slowFade: Scenario = {
  id: "slow-fade",
  title: "The Slow Fade",
  personaName: "Theo",
  nodeCaption: "oldest friend",
  relationship:
    "Your closest friend for a decade. Neither of you did anything wrong; you just stopped being in each other's days.",
  genre: "Drifting friendship",
  stakes: "The replies have got slower and shorter for months and neither of you has named it.",
  unresolved:
    "Whether this is a friendship in a quiet season or one that already ended without an announcement.",
  silenceDuration: "3 weeks of silence",
  voiceNotes:
    "Warm, a little guarded now. Replies late and apologises for it every time. Keeps things light and deflects with a joke when a conversation gets close to the actual subject. Would not say he is hurt.",
  hubLabel: "friends",
  accent: "azure",
  leaves: ["ten years", "he moved", "left on read", "the group chat"],
  portrait: "/portraits/maxim.png",
  history: [
    {
      isFromMe: true,
      text: "saw a guy on the train reading that book you wouldn't shut up about in 2019",
      timestamp: "3 weeks ago",
    },
    { isFromMe: false, text: "HA. vindicated", timestamp: "3 weeks ago" },
    { isFromMe: false, text: "sorry for the slow reply, things have been mad", timestamp: "3 weeks ago" },
    { isFromMe: true, text: "all good. we should actually catch up properly at some point", timestamp: "3 weeks ago" },
    { isFromMe: false, text: "yes 100%. let me get through this month and I'll text you", timestamp: "3 weeks ago" },
  ],
}

/** Order matters — the graph pairs each scenario with a hand-placed anchor by index. */
export const SCENARIOS: Scenario[] = [
  unsentApology,
  threeDaysOfMaybe,
  operationBirthday,
  theAsk,
  slowFade,
]

export const MAIN_CHARACTER = { name: "Blossom", portrait: "/portraits/blossom.png" }
