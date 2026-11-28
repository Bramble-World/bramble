/**
 * Every product event the server sends, and every property it may carry.
 *
 * A typed union rather than free-form strings, mirroring `AnalyticsEvent` on the
 * Mac. Two reasons, and the second is the important one:
 *
 * - A typo in an event name is a silently missing metric that nobody notices
 *   until they go looking for a chart that was never populated.
 * - **The property names are the privacy boundary.** This product's central
 *   promise is that message content is never written to a long-term store
 *   (invariants.md §1), and an analytics pipeline is a long-term store owned by
 *   someone else. Declaring the shape here means a leak has to be written into
 *   this file rather than slipped into a call site, and the allowlist test reads
 *   from the same place.
 *
 * **Properties are ids, counts, durations and enums. Never text.** No message
 * content, no transcript, no person or character names, no storyline titles, no
 * narrative, no email, no contact ref. If a property could carry a sentence
 * someone wrote, it does not belong here.
 */

export type AnalyticsEvent =
  | {
      name: 'beat_played';
      properties: {
        /** Position in the session, not a count of anything the reader wrote. */
        turn_order: number;
        /** Surface *types* only — the enum, never the rendered text. */
        surfaces: string[];
        /** Whether the extracted script has run out and the model is inventing. */
        beyond_script: boolean;
        /** Whether this playthrough began at a moment the reader picked. */
        started_from_event: boolean;
        generation_ms: number;
        /**
         * From the request reaching the server to the beat being written: the
         * writing plus anything settled first. What the player waited, less the network.
         */
        wait_ms: number;
        /**
         * Streamed only: from the request reaching the server to the first
         * piece of the beat (its headline or first text) being sent.
         */
        first_part_ms?: number;
        /** Where the story came from; `none` for one not from the pool (a guest's opening, a Mac import). Never which one. */
        origin: 'seed' | 'reborn' | 'reddit' | 'chatgpt' | 'duet' | 'none';
        /** On the first story only: its length in the 5-or-10 test (story-phase.ts). */
        first_story_beats?: number;
        /** While the pauses test runs, which half this player is in (pauses.ts). */
        pauses_arm?: 'pauses' | 'none';
      };
    }
  | {
      /** A beat that pauses was answered: its reply comes later, in real time (pauses.ts). */
      name: 'reply_paused';
      properties: { delay: 'soon' | 'tonight' | 'tomorrow' };
    }
  | {
      /** The reply sweep wrote a reply that was owed. `late_ms`: how long after it was due. */
      name: 'reply_arrived';
      properties: { delay: 'soon' | 'tonight' | 'tomorrow'; late_ms: number };
    }
  | {
      name: 'import_completed';
      properties: {
        status: 'ready' | 'failed';
        /** Present only when failed. A code, never a message. */
        failure_code?: string;
        /** Queued to terminal, in milliseconds. */
        duration_ms: number;
        /**
         * How many messages the transcript held. A count, never the messages.
         *
         * Absent when the worker never read one — the branch that adopts a
         * storyline a previous attempt had already written, and any failure
         * before the transcript was fetched. Reporting 0 there would be a
         * measurement of nothing dressed as a measurement of something.
         */
        message_count?: number;
      };
    }
  | {
      name: 'energy_depleted';
      properties: {
        limit: number;
        retry_after_s: number;
      };
    }
  /*
   * The iPhone's guest onboarding. `save_shown` and `save_not_now` belong to the
   * same funnel but happen only on the device, so the app sends those itself.
   */
  | {
      name: 'onboarding_opened';
      properties: {
        /** Which scripted opening was shown — an id from `openings.ts`, never its text. */
        opening_id: string;
      };
    }
  | {
      name: 'person_named';
      properties: {
        /** The chip the guest picked. An enum; the name they typed never ships. */
        relationship: 'ex' | 'old_friend' | 'crush' | 'boss' | 'sibling';
        /** Whether they chose pronouns or skipped. Not which ones. */
        pronouns_given: 'yes' | 'no';
        /** Why the texter is texting at 1:47 AM (premises.ts). An enum. */
        premise:
          | 'wedding'
          | 'moving_away'
          | 'just_broke_up'
          | 'saw_you_tonight'
          | 'found_the_photo';
      };
    }
  | {
      name: 'guest_beat_played';
      properties: {
        /** 1 for the scripted beat, 2 and 3 for the written ones. */
        n: number;
      };
    }
  | {
      name: 'signup_completed';
      properties: {
        /** How they signed up, as the app reports it. Absent when it did not say. */
        method?: 'apple' | 'passkey' | 'email';
        /** Whether the guest story joined an account that already existed. */
        merged: boolean;
      };
    }
  | {
      name: 'story_ended';
      properties: {
        /** How many beats the story took, the ending included. */
        turns: number;
        /** Whether the model chose to end it, or the length cap made it. */
        phase: 'closing' | 'must_end';
        /** Where the story came from; `none` for one not from the pool. Never which one. */
        origin: 'seed' | 'reborn' | 'reddit' | 'chatgpt' | 'duet' | 'none';
        /** On the first story only: its length in the 5-or-10 test (story-phase.ts). */
        first_story_beats?: number;
      };
    }
  | {
      name: 'next_story_started';
      properties: {
        /** Where the pool story came from. Never which one, and never its author. */
        origin: 'seed' | 'reborn' | 'reddit' | 'chatgpt' | 'duet';
        /** The countdown ran out, the reader tapped "begin now", or began it later from the notebook. */
        how: 'countdown' | 'begin_now' | 'later';
      };
    }
  | {
      /** The first time an account used Bramble in ChatGPT. */
      name: 'chatgpt_connected';
      properties: Record<string, never>;
    }
  | {
      /** A story was asked for from ChatGPT. Never what was sent. */
      name: 'chatgpt_story_requested';
      properties: {
        /**
         * Queued to be written, over the day's limit, flagged by moderation and
         * not kept, or (a link) nothing in it to write a story from.
         */
        outcome: 'queued' | 'limited' | 'flagged' | 'not_written';
        /** `write_my_story` in ChatGPT, or a link ChatGPT wrote, opened in the iPhone app. */
        via: 'mcp' | 'link';
        /** How many stories were queued: one at most from `write_my_story`, up to five from a link. */
        stories: number;
        /** A link that came to nothing: how many situations the model found in it before fitting (fit.ts). */
        situations_returned?: number;
        /** The note's size band (under 200 characters, up to 1000, more) and paragraph count: never its text. */
        note_size?: 'short' | 'medium' | 'long';
        paragraphs?: number;
        /** Why the model left situations out, as codes (situations.prompt.ts `SKIP_REASONS`). */
        skipped?: string[];
      };
    }
  | {
      /** A player made an invite to a story for two. No code, no name. */
      name: 'invite_created';
      properties: Record<string, never>;
    }
  | {
      /** Someone accepted an invite: a story for two was made, for both. */
      name: 'invite_accepted';
      properties: Record<string, never>;
    }
  | {
      /**
       * The inviter's own record that their invite was accepted (`invite_accepted`
       * is the accepter's). With `invite_created` and `duet_partner_started`, the
       * inviter's funnel, without any id joining the two players.
       */
      name: 'invite_was_accepted';
      properties: Record<string, never>;
    }
  | {
      /** The other player started their side of a story for two, recorded against this one. */
      name: 'duet_partner_started';
      properties: { side: 'a' | 'b' };
    }
  | {
      /** A player started their side of a story for two: `a` the inviter's, `b` the invitee's. */
      name: 'duet_started';
      properties: { side: 'a' | 'b' };
    }
  | {
      /**
       * Something one side did that the other's character would know, queued
       * for the other side (recorded against its player). Counts and codes only.
       */
      name: 'duet_crossed';
      properties: { from_side: 'a' | 'b'; held: boolean; count: number };
    }
  | {
      /** A crossing reached the other player's beat. */
      name: 'duet_crossing_delivered';
      properties: Record<string, never>;
    }
  | {
      name: 'story_reported';
      properties: {
        /** The reason the reader picked: a code, never their words or the story's. */
        reason: 'harmful' | 'sexual' | 'hateful' | 'self_harm' | 'real_person' | 'other';
        /** Where the story came from; `none` for a story that is not from the pool. Never which one. */
        origin: 'seed' | 'reborn' | 'reddit' | 'chatgpt' | 'duet' | 'none';
      };
    }
  | {
      name: 'push_sent';
      properties: {
        /** An enum: what a notification says is decided by this, and never stored. */
        kind:
          | 'battery_back'
          | 'story_waiting'
          | 'story_ready'
          | 'reply_arrived'
          | 'duet_moved'
          | 'invite_accepted';
        /** For story_waiting: which wording went (push.policy.ts). Never the words or a count. */
        copy?: 'today' | 'texts' | 'choice';
      };
    };

export type AnalyticsEventName = AnalyticsEvent['name'];

/**
 * Every property key any event is allowed to carry.
 *
 * Derived by hand rather than from the types, because the point is to be a
 * second, independent statement of what may ship — a list generated from the
 * same types it checks would agree with them by construction and prove nothing.
 * The test asserts real captured events against this.
 */
export const ALLOWED_PROPERTY_KEYS = [
  'turn_order',
  'surfaces',
  'beyond_script',
  'started_from_event',
  'generation_ms',
  'wait_ms',
  'first_part_ms',
  'status',
  'failure_code',
  'duration_ms',
  'message_count',
  'limit',
  'retry_after_s',
  'opening_id',
  'relationship',
  'pronouns_given',
  'premise',
  'n',
  'method',
  'merged',
  'kind',
  'phase',
  'origin',
  'how',
  'turns',
  'reason',
  'outcome',
] as const;
