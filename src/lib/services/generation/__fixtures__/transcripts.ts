import { Transcript } from '../extraction.service';

/**
 * Transcripts written for this pipeline.
 *
 * Deliberately not taken from `src/lib/demo/scenarios.ts` — that is investor
 * prototype material, hardcoded to show the app quickly, and it is not a
 * specification for anything.
 *
 * Each one exercises something the extraction path has to get right rather than
 * just being plausible text. The two below share a handle, which is the only way
 * to prove that a person appearing in a second conversation resolves to the row
 * that already exists instead of becoming a duplicate.
 */
const MAYA = '+1 (555) 010-4477';

/** A falling-out that never quite gets named. */
export const unsentApology: Transcript = {
  surface: 'imessage',
  messages: [
    {
      isFromMe: false,
      handle: MAYA,
      sender: 'Maya',
      text: "you didn't have to say it like that, in front of everyone",
      sentAt: '2026-03-02T19:04:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      sender: 'me',
      text: 'I know. I was tired and I took it out on you.',
      sentAt: '2026-03-02T19:41:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      sender: 'Maya',
      text: "it's fine",
      sentAt: '2026-03-02T19:42:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      sender: 'me',
      text: 'it clearly is not fine',
      sentAt: '2026-03-02T19:43:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      sender: 'Maya',
      text: 'I have to go, lasagna is burning. again.',
      sentAt: '2026-03-02T19:45:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      sender: 'me',
      text: 'maya',
      sentAt: '2026-03-02T19:58:00Z',
    },
  ],
};

/**
 * The same person, three weeks later, from the same handle.
 *
 * Extracting this after the first must reuse Maya's `persons` row rather than
 * creating a second one — that reuse is the entire basis for cross-storyline
 * continuity, and its failure mode is silent.
 */
export const threeWeeksLater: Transcript = {
  surface: 'imessage',
  messages: [
    {
      isFromMe: true,
      handle: 'me',
      sender: 'me',
      text: 'are you around this weekend',
      sentAt: '2026-03-24T11:12:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      sender: 'Maya',
      text: 'depends who else is coming',
      sentAt: '2026-03-24T14:50:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      sender: 'me',
      text: 'just me. I will even bring the lasagna.',
      sentAt: '2026-03-24T14:51:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      sender: 'Maya',
      text: 'absolutely not. I will cook.',
      sentAt: '2026-03-24T14:53:00Z',
    },
  ],
};

/**
 * A group chat, where the thread and the speaker are not the same thing.
 *
 * The two-party transcripts above cannot show the failure this exists for: when
 * every message in a thread comes from one person, reading the speaker off the
 * thread name looks correct. Here three people share one `handle`, and anything
 * that attributes by thread collapses them into one voice — which is how a
 * participant stops being cast at all.
 */
export const movingWeekend: Transcript = {
  surface: 'imessage',
  messages: [
    {
      isFromMe: false,
      handle: 'Apartment 4B',
      sender: 'Andi',
      text: 'landlord says we can pick up keys friday',
      sentAt: '2026-07-14T09:02:00Z',
    },
    {
      isFromMe: false,
      handle: 'Apartment 4B',
      sender: 'Nathaly',
      text: 'friday is bad for me, can we do saturday',
      sentAt: '2026-07-14T09:20:00Z',
    },
    {
      isFromMe: true,
      handle: 'Apartment 4B',
      sender: 'me',
      text: 'saturday works, I can borrow a van',
      sentAt: '2026-07-14T09:31:00Z',
    },
    {
      isFromMe: false,
      handle: 'Apartment 4B',
      sender: 'Andi',
      text: 'a van! look at us being adults',
      sentAt: '2026-07-14T09:33:00Z',
    },
    {
      isFromMe: false,
      handle: 'Apartment 4B',
      sender: 'Nathaly',
      text: 'I am bringing exactly one chair and no regrets',
      sentAt: '2026-07-14T09:40:00Z',
    },
  ],
};

/** Every message text in a transcript, for asserting none of it was persisted. */
export function verbatimTexts(transcript: Transcript): string[] {
  return transcript.messages.map((message) => message.text);
}
