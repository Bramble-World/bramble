# Bramble Data Model — Reference

This document explains what every table and field in the Bramble schema represents and why it's shaped the way it is. It reflects the schema as of the full walkthrough in this conversation, including every architecture decision resolved along the way.

---

## Core identity

### `users`

One row per Bramble account. Root of ownership for everything else. Follows the existing project convention (`clerkId`, soft-delete via `deletedAt`, partial unique index on active email).

### `persons`

A real contact from the user's life — a sister, a coworker, an ex — stored **once per user**, regardless of how many storylines they appear in. This is the anchor that makes cross-storyline continuity possible: the same real person is the same `persons` row everywhere.

- `sourceContactRef` — a **hashed** phone number or email, used only to detect "have I already created a person for this contact" on re-sync. Never a raw phone/email. Unique per `(userId, sourceContactRef)`.
- `isSelf` — true for exactly one `persons` row per user: the account holder themselves. This lets the user be cast as a `character`, have a `voiceProfile`, and participate in relationships like anyone else. Enforced by a partial unique index (`WHERE isSelf = true`).
- `voiceProfile` — canonical vocabulary, tone, quirks, and sample turns, extracted from how this person actually communicates. Aggregated across every storyline they've appeared in.

### `personRelationships`

The **structural, persistent** fact of what two real people are to each other — siblings, coworkers, close friends. Set once per pair, true regardless of which storyline you're looking at. Deliberately separate from the _narrative_ dynamic (see `characterRelationships` below), the same way `voiceProfile` lives on `persons` while storyline-specific voice deviation lives on `characters`.

- `personAId` / `personBId` — the pair. A `CHECK` constraint (`personAId < personBId`) plus a unique index guarantees the database itself rejects a reversed-duplicate insert — the app must sort the two UUIDs before writing.
- `relationshipType` — "siblings," "coworkers," etc.

---

## Storylines and their structure

### `storylines`

One row per generated story.

- `sourceSurface` — which app the underlying messages came from (`'imessage'`, `'email'`, ...). Plain `text`, not an enum, so adding a new surface never requires a migration.
- `setting` — optional narrative flavor, distinct from `sourceSurface`. Where the data came from vs. what world the story is framed as taking place in.
- `tone` — LLM-generated and LLM-consumed descriptor (e.g., "wistful and a little chaotic"). Stays `text`, not an enum, since there's no user-facing picker — this is never chosen from a fixed list.
- `status` — lifecycle state: `pending` → `generating` → `ready` / `failed`. Answers "is this storyline currently viewable," not "is a background job running" (that's a separate, deferred concern — see Architecture Decisions).
- `failureReason` — set when `status` is `failed`; holds enough detail to debug or explain the failure.
- `arcSummary` — a computed, high-level description of how things changed over the storyline (e.g., "started distant, ended reconciled"). Derived from `events` after the fact, not authored directly.
- `arcSummaryGeneratedAt` — timestamp of the last recompute. Recomputation is **session-based**: triggered when a `storylineSession` goes idle, if any `conversation_generated` events were added since the last recompute. Compare against the latest event's `createdAt` to detect staleness.

### `storylineLinks`

Explicit connections between two storylines — `sequel`, `parallel`, `crossover`, `spinoff` — so relationships between stories are queryable rather than inferred from shared characters. A low-risk, standalone table; not yet used by any built feature (cross-storyline continuity is deferred), but no dependencies elsewhere in the schema, so it costs nothing to have in place early.

---

## Characters, relationships, and their evolution

### `characters`

A **per-storyline instantiation** of a `person` — "who they are in this particular story." Points to exactly one `persons` row via `personId`.

- `role` — `protagonist` / `antagonist` / `supporting`.
- `description` — storyline-specific framing.
- `voiceProfileOverride` — optional deviation from the person's canonical voice, scoped to just this storyline.

### `characterRelationships`

The **narrative, storyline-scoped** dynamic between two characters — how things stand at the _start_ of this particular story. (The structural relationship type itself lives on `personRelationships`.)

- `characterAId` / `characterBId` — the pair, scoped to one storyline. Same `CHECK`-constraint + unique-index pattern as `personRelationships`, scoped additionally by `storylineId`.
- `baselineDynamic` — closeness, tension, power balance at the story's outset.

### `relationshipStates`

How a relationship's dynamic **evolves** over the course of a storyline. Each row is a snapshot tied to the specific `event` that caused the shift — so you can reconstruct "what was this relationship like at any point in the story" by finding the latest state at or before a given point in the narrative. Populated by the pipeline whenever an event meaningfully changes how two characters relate.

---

## The canonical timeline

### `events`

The actual beats of the story — an append-only canonical timeline.

- `narrativeOrder` — the order beats are _presented_ in. Deliberately separate from `occurredAt` (when it really happened, if known), since a good story doesn't have to unfold in strict chronological order — it can compress, reorder, or flash back. **Convention: seed initial events at 10, 20, 30...** so a later mid-story insert can take an unused gap value (e.g., 15) without renumbering everything after it.
- `title` — a short label, for scanning/display (a timeline view, a heading) — not the narrative prose itself.
- `description` — the actual story content, shown to the user and fed to the LLM as narrative context.
- `stakes` — what's at risk, why this beat matters. Mostly a generation-steering signal fed back into the LLM (to guide escalation/resolution of tension), not necessarily shown to the user as its own field.
- `origin` — `extracted` (from the initial message pipeline) or `conversation_generated` (added because the user steered the story through a decision). This is the mechanism that makes conversation-steering traceable.
- `triggeredByTurnId` — for `conversation_generated` events, points to the exact `storyTurns` row (the decision) that caused this beat to be added to canon.
- `generationRationale` — a short, LLM-generated explanation of _why_ this beat was created. Explicitly **not** a pointer to raw source content — Bramble never persists raw messages, so there's nothing to point back to. This is the model's own reasoning, generated as part of the same call that produced the event.

### `eventParticipants`

Many-to-many join between `events` and `characters` — which characters were involved in which beats.

---

## The choice-driven interaction loop

This replaced an earlier freeform "chat" design once it became clear the actual interaction model is decision-based: the LLM presents narrative content plus a set of options, and the user picks one — not a typed conversation.

### `storylineSessions`

One **playthrough** — the user interacting with a storyline through the decision interface, possibly across multiple sittings. Distinct from `storylines` the same way `characters` is distinct from `persons`: the storyline is the persistent story; a session is one scoped instance of engaging with it.

- `lastActiveAt` — touched whenever the user answers a turn. This is what makes "the session went idle" detectable: nothing asks a user to end a session, they just stop, so idleness is inferred by a sweep over `WHERE lastActiveAt < now() - <threshold>` rather than declared. Deliberately denormalised — it equals `MAX(storyTurns.respondedAt)` for the session, but deriving it would mean joining and aggregating every session's turns on every sweep. Distinct from `updatedAt`, which changes whenever the row does, for reasons the user may have had nothing to do with.

Nothing marks a session as "already summarised." Deduplication happens at the storyline level instead: if `arcSummaryGeneratedAt` is newer than the most recent event, there is nothing to recompute and the sweep skips it.

### `storyTurns`

One **decision point**. Created when the LLM presents a beat and its options; updated in place once the user answers.

- `turnOrder` — sequencing within a session.
- `narrativeContent` — what the LLM presented at this decision point.
- `selectedChoiceId` — nullable; filled once the user picks. `null` means the turn is still awaiting a response.
- `respondedAt` — when the user answered.

Note: `storyTurns.selectedChoiceId` and `turnChoices.turnId` reference each other. In practice this means a two-step write: insert the turn (with `selectedChoiceId: null`), insert its `turnChoices`, then `UPDATE` the turn once the user picks — not a single atomic row.

### `turnChoices`

The options attached to one `storyTurn` — `label`, `description`, `orderIndex`.

---

## Backstory and continuity

### `contextEntries`

Unstated backstory the raw data implies but never explains — "they had a falling out in 2019," "she just moved to a new city." Fed to the LLM as background it should know but not necessarily state outright.

- `characterId` — nullable. `null` means the entry applies to the whole storyline; set means it's specific to one character.
- `source` — `inferred` (pipeline guessed it during initial extraction), `conversation_generated` (pipeline inferred it during a later session), or `user_provided` (the user stated it directly).
- `triggeredByTurnId` — for `conversation_generated` entries, the specific turn/decision whose choice caused this backstory to be inferred. Mirrors `events.triggeredByTurnId`.

### `motifs`

Recurring references, inside jokes, and callbacks — owned by the **user**, not any one storyline, since a running joke belongs to the people, not to one story about them.

- `label` — short name (e.g., "the lasagna incident").
- `description` — more detail.

### `motifParticipants`

Many-to-many join between `motifs` and `persons` — whose joke this is (can be one person's individual quirk or shared between several).

### `motifOccurrences`

Tracks every place a motif actually surfaces — which storyline, and optionally which specific event. This is what lets a callback in a new storyline point back to where the joke first appeared.

---

## Architecture decisions — resolved and deferred

Everything below was raised during the schema walkthrough. Resolved items are already reflected in the tables above; deferred items are known gaps, intentionally left for later since none of them block MVP and all are additive (new tables/fields, not restructuring).

### Resolved

- **`tone` stays `text`** — LLM-generated and LLM-consumed, no user-facing picker.
- **`failureReason`** added to `storylines` for debugging failed generation.
- **`arcSummary` recomputation is session-based** — triggered when a session goes idle, checked against `conversation_generated` events since the last `arcSummaryGeneratedAt`.
- **Gap-based `narrativeOrder` numbering adopted** (10, 20, 30...) — an insert-logic convention, not a schema constraint.
- **No raw message persistence.** Raw/selected messages are passed to the LLM transiently during generation and never stored. `sourceRefs` was renamed to `generationRationale` (the model's own reasoning) as a result.
- **`sourceContactRef` format** — a one-way hash of phone/email, never the raw value.
- **`contextEntries.source` gained `conversation_generated`**, and `triggeredByTurnId` was added for lineage — mirroring `events`.
- **`relationshipType` split out** into the persistent `personRelationships` table, separate from the storyline-scoped `baselineDynamic`.
- **Canonical-ordering `CHECK` constraints** added to both `characterRelationships` and `personRelationships`, so the database — not just app convention — rejects reversed-duplicate pairs.
- **Interaction model restructured** from freeform chat (`conversations`/`messages`) to decision-based (`storylineSessions`/`storyTurns`/`turnChoices`), matching how users actually interact with the LLM.

### Deferred (revisit later; all additive, none block MVP)

1. **Surface-keyed voice profiles + splitting `sourceContactRef` into its own table** (`personContactRefs`), to support a person reachable via multiple surfaces (phone _and_ email). Deferred as too complex for MVP.
2. **A dedicated `generationJobs` table** (job type, status, error, timing, FK'd to `storylines`), once background re-sync/regeneration is actually built. `storylines.status` + `failureReason` cover the one-shot MVP case.
3. **`stakes` → resolving-event link** — a way to mark which later event resolves the tension introduced by an earlier one. Revisit if cross-event arc coherence becomes a real quality problem.
4. **Confidence score on `inferred` `contextEntries`** — only matters if inferred backstory is ever surfaced to users as fact rather than fed silently to the LLM.
5. **Embeddings (pgvector) for `contextEntries` / `motifs` retrieval** — relevance-based selection instead of including everything in a fixed order, once volume makes "just include all of them" impractical.
6. **Denormalized `currentDynamic` field on `characterRelationships`** — a fast, single-row read for "current relationship state," avoiding a join through `relationshipStates` + `events` on every read. Worth adding only if this becomes a frequently-loaded UI element (e.g., a badge shown on every card) rather than an occasional detail-view lookup.

---

_Generated from the schema design conversation covering Bramble's Drizzle/Postgres data model._
