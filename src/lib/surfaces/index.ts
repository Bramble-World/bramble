import type { z } from 'zod';
import {
  IMESSAGE_TYPE,
  IMESSAGE_VERSION,
  imessageFromModel,
  imessageHistoryLine,
  imessagePayloadSchema,
  imessagePersonIds,
  resolveImessage,
  type ImessageModelFields,
} from './imessage.surface';
import type {
  NewTurnSurface,
  ResolvedSurface,
  StoredTurnSurface,
  SurfaceCastMember,
  SurfacePerson,
} from './surfaces.types';

export type * from './surfaces.types';

/**
 * The registry: one entry per surface type.
 *
 * Adding a surface is an entry here, its own `*.surface.ts`, a member of
 * `ResolvedSurface`, a case in `surfaceHistoryLine` and in the view — and never
 * a migration, because `turn_surfaces.type` is text and `payload` is jsonb.
 */
type Definition<Payload> = {
  version: number;
  schema: z.ZodType<Payload>;
  personIds: (payload: Payload) => string[];
  resolve: (payload: Payload, people: ReadonlyMap<string, SurfacePerson>) => ResolvedSurface | null;
};

/** Erases each definition's payload type so they can share one map. */
function define<Payload>(definition: Definition<Payload>) {
  return {
    version: definition.version,
    read(payload: unknown) {
      const parsed = definition.schema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        personIds: definition.personIds(parsed.data),
        resolve: (people: ReadonlyMap<string, SurfacePerson>) =>
          definition.resolve(parsed.data, people),
      };
    },
  };
}

const REGISTRY: Record<string, ReturnType<typeof define>> = {
  [IMESSAGE_TYPE]: define({
    version: IMESSAGE_VERSION,
    schema: imessagePayloadSchema,
    personIds: imessagePersonIds,
    resolve: resolveImessage,
  }),
};

/** What the turn prompt lets the model choose from. `none` means text only. */
export const SURFACE_KINDS = ['none', IMESSAGE_TYPE] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** The flattened surface fields of the turn output. */
export type SurfaceModelFields = ImessageModelFields & { surfaceKind: SurfaceKind };

/**
 * What the model asked to show, validated, ready to store.
 *
 * The model picks at most one surface per turn for now; the table and the API
 * already carry a list, so a turn with two (an email with a boarding pass
 * attached) is a prompt change, not a schema one.
 */
export function surfacesFromModel(
  fields: SurfaceModelFields,
  cast: SurfaceCastMember[]
): NewTurnSurface[] {
  switch (fields.surfaceKind) {
    case 'none':
      return [];
    case IMESSAGE_TYPE: {
      const surface = imessageFromModel(fields, cast);
      return surface ? [surface] : [];
    }
  }
}

/**
 * Reads stored rows back. A row of a type this build does not know, of a
 * version it cannot read, or whose payload no longer fits its schema is
 * skipped: one unreadable surface must never make a turn unplayable.
 */
function readable(stored: StoredTurnSurface) {
  const entry = REGISTRY[stored.type];
  if (!entry || entry.version !== stored.version) return null;
  return entry.read(stored.payload);
}

/** Every person the stored surfaces mention, so they can be looked up in one query. */
export function surfacePersonIds(stored: StoredTurnSurface[]): string[] {
  return [...new Set(stored.flatMap((s) => readable(s)?.personIds ?? []))];
}

export function resolveSurfaces(
  stored: StoredTurnSurface[],
  people: ReadonlyMap<string, SurfacePerson>
): ResolvedSurface[] {
  return stored.flatMap((s) => {
    const resolved = readable(s)?.resolve(people);
    return resolved ? [resolved] : [];
  });
}

/** One line about a surface, for prompts that need to remember what was on screen. */
export function surfaceHistoryLine(surface: ResolvedSurface): string {
  switch (surface.type) {
    case IMESSAGE_TYPE:
      return imessageHistoryLine(surface);
  }
}
