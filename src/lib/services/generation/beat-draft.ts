import type { DeepPartial } from '@/lib/ai/prompt';
import type { TurnOutput } from '@/lib/ai/prompts/turn.prompt';
import {
  resolveSurfaces,
  surfacesFromModel,
  type ResolvedSurface,
  type SurfaceCastMember,
  type SurfaceKind,
  type SurfaceModelFields,
} from '@/lib/surfaces';

/**
 * A beat while the model is still writing it: only the pieces it has finished.
 *
 * Streamed to the reader so the first text lands in seconds rather than when
 * the whole beat is done. Never half a text: a field counts as finished once
 * the model has moved on to a later one, which is why the turn schema writes
 * the headline, then the texts, then the narrative, with the choices last (they
 * arrive only with the finished beat, after its checks).
 *
 * Built with the same functions as the saved turn, so a streamed text has the
 * same sender, the same splitting and the same limits as the one that's kept:
 * a sender the reader hasn't met is dropped here exactly as it is there.
 */
export type BeatDraft = {
  /**
   * What the beat is, once the model has said: texts on the phone, or none
   * (a plain beat). Null until then. Lets a client show a plain beat from its
   * headline without mistaking a beat whose texts are still coming for one.
   */
  kind: SurfaceKind | null;
  headline: string | null;
  surfaces: ResolvedSurface[];
  narrative: string | null;
};

/** The turn schema's field order, which is the order the model writes in. */
const ORDER = [
  'isEnding',
  'headline',
  'surfaceKind',
  'clockTime',
  'dateLabel',
  'notifications',
  'narrative',
  'replyLater',
  'choices',
] as const satisfies readonly (keyof TurnOutput)[];

/** Whether the model has started on any field after `key`, so `key` is done. */
function finished(partial: DeepPartial<TurnOutput>, key: (typeof ORDER)[number]): boolean {
  return ORDER.slice(ORDER.indexOf(key) + 1).some((later) => partial[later] !== undefined);
}

export type DraftCastMember = SurfaceCastMember & { name: string };

export function beatDraft(
  partial: DeepPartial<TurnOutput>,
  cast: readonly DraftCastMember[]
): BeatDraft {
  const kind = finished(partial, 'surfaceKind') ? (partial.surfaceKind ?? null) : null;
  const headline = finished(partial, 'headline') ? partial.headline?.trim() || null : null;
  const narrative = finished(partial, 'narrative') ? partial.narrative?.trim() || null : null;

  let surfaces: ResolvedSurface[] = [];
  if (partial.surfaceKind === 'imessage_notifications' && finished(partial, 'dateLabel')) {
    const written = partial.notifications ?? [];
    // The last one may still be mid-word until something follows it.
    const done = finished(partial, 'notifications') ? written : written.slice(0, -1);
    const notifications = done.flatMap((n) =>
      n?.senderCharacterId && n.text
        ? [{ senderCharacterId: n.senderCharacterId, text: n.text }]
        : []
    );
    if (notifications.length) {
      const fields: SurfaceModelFields = {
        surfaceKind: 'imessage_notifications',
        clockTime: partial.clockTime ?? null,
        dateLabel: partial.dateLabel ?? null,
        notifications,
      };
      const people = new Map(
        cast.map((c) => [c.personId, { id: c.personId, name: c.name, isSelf: c.isSelf }])
      );
      surfaces = resolveSurfaces(surfacesFromModel(fields, [...cast]), people);
    }
  }

  return { kind, headline, surfaces, narrative };
}

/** Nothing finished yet: not worth sending. */
export function isEmptyDraft(draft: BeatDraft): boolean {
  return !draft.headline && draft.surfaces.length === 0 && !draft.narrative;
}
