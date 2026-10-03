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
      };
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
  'status',
  'failure_code',
  'duration_ms',
  'message_count',
  'limit',
  'retry_after_s',
] as const;
