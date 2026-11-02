export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number];

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
