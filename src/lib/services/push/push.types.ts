export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number];

/**
 * `story_ready` is sent once, when a story asked for in ChatGPT has been
 * written (`announceStoryReady`), not by the sweep, and isn't kept in
 * `push_sends`: a template becomes ready only once. `reply_arrived` is sent by
 * the reply sweep when a reply someone in the story owed has been written
 * (pauses.ts), and is kept in `push_sends`, which is also what keeps "story
 * waiting" at least 20 hours behind it. `invite_accepted` is sent once, to the
 * inviter, when their friend accepts (`announceInviteAccepted`), not by the
 * sweep: an invite is accepted only once.
 */
export type PushKind =
  | 'battery_back'
  | 'story_waiting'
  | 'story_ready'
  | 'reply_arrived'
  | 'duet_moved'
  | 'invite_accepted';

/**
 * What a notification says. Apple carries this text, and a lock screen shows it
 * to anyone nearby, so it must never hold a name or a line of a story.
 */
export type PushMessage = { title: string; body: string };

/**
 * What Apple said about one token.
 *
 * `gone` means the token will never work again, so its row should be deleted.
 * `failed` is anything else, and says nothing about the token.
 */
export type PushOutcome =
  | { kind: 'delivered' }
  | { kind: 'gone'; reason: string }
  | { kind: 'failed'; reason: string };
