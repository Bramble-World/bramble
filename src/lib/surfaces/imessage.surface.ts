import { z } from 'zod';
import type {
  NewTurnSurface,
  ResolvedImessageNotifications,
  SurfaceCastMember,
  SurfacePerson,
} from './surfaces.types';

export const IMESSAGE_TYPE = 'imessage_notifications';
export const IMESSAGE_VERSION = 1;

/** A lock screen shows a handful at most, and the newest is the one that matters. */
export const MAX_NOTIFICATIONS = 3;
const MAX_TEXT = 240;

/**
 * What one message should read like, and what the prompt asks for.
 *
 * Advisory rather than enforced: a text a little over this still renders, and
 * dropping a beat's only notification over a character count would be a worse
 * outcome than a slightly long line. `MAX_TEXT` is the hard ceiling the column
 * enforces; this is the shape we ask for.
 */
export const MAX_NOTIFICATION_CHARS = 90;
const MAX_CLOCK = 16;
const MAX_DATE = 40;

/**
 * What is stored. Senders are both ids: the character is who the model named,
 * the person is who the reader knows, and the view needs the person.
 */
export const imessagePayloadSchema = z.object({
  clockTime: z.string().max(MAX_CLOCK).nullable(),
  dateLabel: z.string().max(MAX_DATE).nullable(),
  notifications: z
    .array(
      z.object({
        characterId: z.string().min(1),
        personId: z.string().min(1),
        text: z.string().min(1).max(MAX_TEXT),
      })
    )
    .min(1)
    .max(MAX_NOTIFICATIONS),
});

export type ImessagePayload = z.infer<typeof imessagePayloadSchema>;

/** The model's half of the turn output that describes this surface. */
export type ImessageModelFields = {
  clockTime: string | null;
  dateLabel: string | null;
  notifications: Array<{ senderCharacterId: string; text: string }>;
};

/**
 * Turns what the model wrote into something safe to store, or nothing.
 *
 * A notification survives only if its sender is in `cast` — which the caller
 * has already cut to the characters the reader has met — and is not the reader:
 * nobody gets a text from themselves, and the one thing the model may not
 * invent is a person. Anything else is dropped rather than repaired, and a
 * surface with nothing left is no surface. The turn itself never fails over
 * this; it simply plays as text.
 */
export function imessageFromModel(
  fields: ImessageModelFields,
  cast: SurfaceCastMember[]
): NewTurnSurface | null {
  const senders = new Map(cast.filter((c) => !c.isSelf).map((c) => [c.id, c]));

  const notifications = fields.notifications
    .flatMap((n) =>
      asSeparateMessages(n.text).map((text) => ({ sender: senders.get(n.senderCharacterId), text }))
    )
    .filter((n) => n.sender && n.text.length > 0 && n.text.length <= MAX_TEXT)
    // After splitting, so a model that packed three messages into one line does
    // not get more than three through the back door.
    .slice(0, MAX_NOTIFICATIONS)
    .map((n) => ({ characterId: n.sender!.id, personId: n.sender!.personId, text: n.text }));

  if (notifications.length === 0) return null;

  const payload: ImessagePayload = {
    clockTime: shortOrNull(fields.clockTime, MAX_CLOCK),
    dateLabel: shortOrNull(fields.dateLabel, MAX_DATE),
    notifications,
  };
  return { type: IMESSAGE_TYPE, version: IMESSAGE_VERSION, payload };
}

/**
 * One notification per message, however the model packed them.
 *
 * The prompt asks for one message per notification, and a lock screen renders
 * it that way — a single notification is one bubble, and a text with newlines in
 * it is drawn as one bubble that gets cut off. So a slip is repaired here rather
 * than trusted not to happen: the card is the thing the reader sees, and it has
 * no way to show the rest.
 *
 * **Reversed, because the array is newest first.** Lines inside one block are
 * written the way anyone types them — oldest at the top — so the last line is
 * the most recent message and belongs at the front of a newest-first list. A
 * single-line text is unaffected.
 */
function asSeparateMessages(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.reverse();
}

export function imessagePersonIds(payload: ImessagePayload): string[] {
  return payload.notifications.map((n) => n.personId);
}

/**
 * Looks the senders up. A notification whose person no longer exists is
 * dropped, and if that leaves none the surface is not shown at all.
 */
export function resolveImessage(
  payload: ImessagePayload,
  people: ReadonlyMap<string, SurfacePerson>
): ResolvedImessageNotifications | null {
  const notifications = payload.notifications.flatMap((n) => {
    const sender = people.get(n.personId);
    return sender ? [{ sender, text: n.text }] : [];
  });
  if (notifications.length === 0) return null;

  return {
    type: IMESSAGE_TYPE,
    clockTime: payload.clockTime,
    dateLabel: payload.dateLabel,
    notifications,
  };
}

/** `On your phone — Maya: "…"; Theo: "…"`, oldest first so it reads in order. */
export function imessageHistoryLine(surface: ResolvedImessageNotifications): string {
  const texts = [...surface.notifications]
    .reverse()
    .map((n) => `${n.sender.name}: "${n.text}"`)
    .join('; ');
  return `On your phone — ${texts}`;
}

function shortOrNull(value: string | null, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}
