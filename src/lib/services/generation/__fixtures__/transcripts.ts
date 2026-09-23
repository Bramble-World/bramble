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
      text: "you didn't have to say it like that, in front of everyone",
      sentAt: '2026-03-02T19:04:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      text: 'I know. I was tired and I took it out on you.',
      sentAt: '2026-03-02T19:41:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      text: "it's fine",
      sentAt: '2026-03-02T19:42:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      text: 'it clearly is not fine',
      sentAt: '2026-03-02T19:43:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      text: 'I have to go, lasagna is burning. again.',
      sentAt: '2026-03-02T19:45:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
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
      text: 'are you around this weekend',
      sentAt: '2026-03-24T11:12:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      text: 'depends who else is coming',
      sentAt: '2026-03-24T14:50:00Z',
    },
    {
      isFromMe: true,
      handle: 'me',
      text: 'just me. I will even bring the lasagna.',
      sentAt: '2026-03-24T14:51:00Z',
    },
    {
      isFromMe: false,
      handle: MAYA,
      text: 'absolutely not. I will cook.',
      sentAt: '2026-03-24T14:53:00Z',
    },
  ],
};

/** Every message text in a transcript, for asserting none of it was persisted. */
export function verbatimTexts(transcript: Transcript): string[] {
  return transcript.messages.map((message) => message.text);
}
