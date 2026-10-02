/**
 * Story surfaces: the artifacts a turn plays out on.
 *
 * A turn always has a headline, a narrative and choices. A surface is extra —
 * the thing the beat is *shown on*: texts arriving on a lock screen, an email,
 * a boarding pass. Each type has its own fields and none of them has a
 * headline, so a surface is stored as `{ type, version, payload }` in
 * `turn_surfaces` and each type validates its own payload.
 *
 * Three shapes per type, and they are deliberately different:
 *
 * - the **payload** is what is stored. People are ids, never names, so a rename
 *   flows through and a sender can only ever be someone in the cast.
 * - the **resolved** surface is the payload with people looked up. It is what
 *   services pass around and what views turn into wire types.
 * - the **history line** is one sentence about it, so later beats and the
 *   consequence prompt remember what was on the screen.
 */

/** A person as a surface shows them. The same fields as `PersonView`. */
export type SurfacePerson = {
  id: string;
  name: string;
  isSelf: boolean;
};

/** What the writer stores. Already validated against its type's schema. */
export type NewTurnSurface = {
  type: string;
  version: number;
  payload: unknown;
};

/** A row as read back, before its payload has been trusted. */
export type StoredTurnSurface = NewTurnSurface;

/** iMessage notifications on the reader's lock screen. */
export type ResolvedImessageNotifications = {
  type: 'imessage_notifications';
  /** The clock on the lock screen, e.g. "1:47". Null when the moment has no particular time. */
  clockTime: string | null;
  /** The date under it, e.g. "Saturday, June 14". Null likewise. */
  dateLabel: string | null;
  /** Newest first, as the lock screen stacks them. Never empty. */
  notifications: Array<{ sender: SurfacePerson; text: string }>;
};

/** Every surface type the backend can serve. Grows by one member per new type. */
export type ResolvedSurface = ResolvedImessageNotifications;

/** A cast member the model may name on a surface. A subset of `CharacterContext`. */
export type SurfaceCastMember = {
  id: string;
  personId: string;
  isSelf: boolean;
};
