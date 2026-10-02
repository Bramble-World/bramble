# Bramble — Application-Level Invariants

`reference.md` explains what each table means. This file lists the rules the
**database cannot enforce**, which the application must therefore guarantee
itself. Every entry here is something Postgres will happily let you violate.

Each rule notes how it fails, so it's clear whether a bug would be loud or
silent. The silent ones are the dangerous ones.

---

## 1. Privacy — the product-level rule

**Message content is never written to a long-term store.** It is held encrypted
in Redis for at most 30 minutes, readable only by the extraction worker, which
deletes it when done. Anthropic receives the transcript to perform the
extraction. Postgres holds only the model's retelling — storylines, people,
events — and an `imports` row with no message content in it. This is the
product's central claim, not an implementation detail.

- `events.generationRationale` holds the model's _own reasoning_, never quoted
  source text.
- `persons.sourceContactRef` is a **one-way hash** of whatever identifies a
  contact: the client's per-person pseudonym (`c_…`) for Mac imports, and a raw
  handle only for lab/CSV input. Writing the raw value would look identical to
  the database.
- **Identity is the handle, never the display name.** `sourceHandle` is described
  to the model as "the exact name this person sent messages under", so what comes
  back is a display name — and hashing it merged a Lauren and an Ollie, each
  labelled "Person A" in a separate conversation, into one `persons` row. The
  name is now only a key into the transcript; extraction maps it to a handle
  itself, and only when the transcript is unambiguous (one handle per name, one
  name per handle, no placeholders). A model's `existingPersonId` never outranks
  a handle, because a misrecognition must not be able to merge two humans.
- **Existing name-derived refs will not match new imports.** Nothing migrates
  them — the old value was a hash of a name and the new one is a hash of a
  pseudonym, and there is no way to recover which was which. Local test data
  should be re-imported rather than repaired.
- **The import path carries no real contact details at all.** The Mac replaces
  phone numbers and emails with keyed pseudonyms (`c_…`) before sending, and the
  API accepts only `me` or that shape — an allow-list, because a deny-list for
  "looks like a phone number" has to anticipate every international format and
  the cost of missing one is a real number reaching a column.
- **Nothing on the import path is logged**: not request bodies, not Redis
  values, not decrypted transcripts, not extraction prompts or outputs. The job
  payload is exactly `{ importId }`, because a queue stores its payloads and
  shows them in a dashboard, which would outlive the ciphertext's 30 minutes.
- **The transcript is encrypted with a key Redis access alone cannot reach.** A
  per-import data key encrypts the transcript; a master key held in a separate
  secret encrypts the data key. Associated data binds each ciphertext to
  `importId:userId`, so a blob cannot be replayed into another import or
  account.

**Fails:** silently, and as a privacy breach rather than a bug. Nothing detects
it. Worth an explicit check in code review of anything touching the generation
pipeline.

**Asserted, not trusted:** `import-runner.integration.test.ts` runs a real
extraction and then scans every column of every table in the schema for a phrase
that only ever existed in a message — rather than the handful of columns anyone
would think to check — and proves the scan itself is not vacuous.

---

## 2. Pair ordering — sort before writing

`personRelationships` and `characterRelationships` each carry a CHECK that
`aId < bId`, so the same pair can't be stored twice in reversed order.

```ts
const [a, b] = [personOneId, personTwoId].sort();
```

**Fails:** loudly. `violates check constraint "chk_person_relationships_order"`.
The database catches this one — it is listed here only so the sort isn't
mistaken for optional.

---

## 3. Cross-scope integrity — the silent class

Every foreign key in the schema is single-column, so **no FK enforces that two
related rows belong to the same parent.** Composite foreign keys would fix this;
they were considered and declined as too heavy for MVP. That decision moves the
burden here.

| Rule                                                                            | What can silently go wrong                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `characters.personId` and `characters.storylineId` must belong to the same user | a storyline cast with another user's person             |
| `characterRelationships.characterAId/BId` must belong to its `storylineId`      | a relationship spanning two storylines                  |
| `eventParticipants.characterId` must belong to the event's storyline            | a character credited in a story they aren't in          |
| `personRelationships.personAId/BId` must belong to its `userId`                 | a relationship joining two users' contacts              |
| `relationshipStates.relationshipId` and `.eventId` must share a storyline       | a state change attributed to an unrelated story's event |
| `motifOccurrences.eventId` must belong to its `storylineId`                     | a callback pointing at the wrong story's beat           |
| **`storyTurns.selectedChoiceId` must be a choice whose `turnId` is that turn**  | a turn recording an answer that was never offered       |

**Fails:** silently, every one. These produce plausible-looking rows that are
wrong. The last is the most likely to bite, because it is the only one on the
hot write path.

Mitigation: do these writes through service functions that take the parent and
derive the children, rather than accepting both ids from a caller.

---

## 4. Conditional columns — nullable, but required in some states

Nothing ties these columns to the state that makes them meaningful.

| Column                             | Must be set when                    | Must be null when            |
| ---------------------------------- | ----------------------------------- | ---------------------------- |
| `storylines.failureReason`         | `status = 'failed'`                 | any other status             |
| `events.triggeredByTurnId`         | `origin = 'conversation_generated'` | `origin = 'extracted'`       |
| `contextEntries.triggeredByTurnId` | `source = 'conversation_generated'` | `inferred` / `user_provided` |
| `storyTurns.respondedAt`           | `selectedChoiceId` is set           | `selectedChoiceId` is null   |

**Fails:** silently. A `failed` storyline with no reason, or an answered turn
with no timestamp, reads as valid.

These _could_ become CHECK constraints later — e.g.
`CHECK ((status = 'failed') = (failure_reason IS NOT NULL))`. Worth doing if any
of them actually drifts.

---

## 5. Write-path obligations

**Answering a turn is three writes in one transaction:**

```
UPDATE story_turns  SET selected_choice_id = …, responded_at = now()
UPDATE storyline_sessions SET last_active_at = now()
UPDATE storyline_sessions SET playhead_order = <next beat above it>
```

`lastActiveAt` is denormalised — it equals `MAX(storyTurns.respondedAt)` for the
session — and exists so the idle sweep is one indexed scan instead of a join and
aggregate over every session's turns. **Forget to touch it and a session looks
idle while someone is actively playing**, so the arc summary recomputes
underneath them.

**Forget the third and the playthrough's view of its own story freezes.** Every
later turn is then generated against the same history, the reader never advances
past the opening beat, and nothing errors — the story simply stops moving while
continuing to produce plausible turns.

**Creating a turn is two steps, because `storyTurns` and `turnChoices` reference
each other:**

1. insert the turn with `selectedChoiceId: null`
2. insert its `turnChoices`
3. later, `UPDATE` the turn when the user picks

There is no single atomic row for a turn-with-choices.

**Every user needs exactly one `isSelf` person.** The partial unique index stops
a _second_ one, but nothing creates the first. Provision it when the user is
provisioned.

---

## 6. Conventions with no enforcement

- **`narrativeOrder` uses gaps of 1000** (1000, 2000, 3000…) so a mid-story
  insert can take 1500 without renumbering. Gaps of 10 were the original
  convention and were too tight: after 10/15/20, a second insert in that slot has
  only 12–14 left, and a handful of steered decisions in one region of a story
  exhaust the integers entirely.
  `(storylineId, narrativeOrder)` **is now unique**, so a collision fails loudly
  instead of leaving two beats to order arbitrarily. Allocate the value inside
  the write transaction — reading the timeline and then inserting outside one is
  a race that the unique index will now reject rather than silently absorb.
- **`storylineLinks` has no ordering CHECK**, deliberately — `sequel` is
  directional. The consequence is that `parallel` and `crossover`, where
  direction is meaningless, _can_ be stored twice reversed. Decide a convention
  if those get used.
- **`storylineSessions.playheadOrder` is how far a playthrough has got**, held
  as an `events.narrativeOrder`. `0` means "before everything", matching what
  `gapOrderAfter` already assumes for an empty timeline. It is **per-session**
  (two readers of one storyline stand in different places), **monotonic** (both
  writers only ever raise it, so a retry cannot walk it backwards), and running
  past the last beat is **not an error** — the step becomes a no-op and the
  reader simply sees everything, which by then is everything they have been
  through.
  The turn stage is shown only beats at or below it; the **arc and consequence
  stages are deliberately shown all of them** and narrowing either breaks
  something quiet (a summary describing only the opening; a relationship state
  with no legal beat to attach to).
- **`arcSummary` is deliberately absent from the turn prompt.** It is computed
  from the whole timeline, so rendering it would hand the model the ending
  however carefully the timeline itself is cut. It survives for the sweep and
  the UI.
- **`storyTurns.consequencesGeneratedAt` is what makes a turn resolved**, and it
  is stamped whatever the consequences came to — including nothing. Inferring it
  from "a beat points at this turn" conflates _never computed_ with _computed and
  legitimately empty_, and the consequence prompt is allowed to return empty, so
  the second is common: 38 of 65 answered turns were in it. Each one re-generated
  on every retry and could write a beat the second time that the first had not.
  Null means "still owed", which is the queryable resumable state the two-call
  answer/consequence split was built around. The claim is a guarded `UPDATE …
WHERE consequences_generated_at IS NULL` inside the write transaction, so two
  concurrent generations cannot both commit beats for one decision.
- **`arcSummary` recompute dedup** is by comparing `arcSummaryGeneratedAt`
  against the newest event's `createdAt`. Nothing marks a session as already
  summarised, so a sweep that ignores this will recompute forever.

---

## 7. Drizzle traps specific to this repo

- **Drizzle 1.0 has two relational APIs and they are not interchangeable.**
  Passing `schema` to `drizzle()` populates `db._query.*` from the older
  `relations()` helper at `drizzle-orm/_relations`; passing `relations`
  populates `db.query.*` from `defineRelations`. This repo uses the second and
  keeps its whole graph in `src/db/relations.ts`. Table files define tables
  only. Adding a `relations()` block back to one does nothing — it is never
  read, because `schema` is not passed.
- **A broken relation typechecks.** Relations resolve when a query runs, so a
  wrong `alias`, a swapped `through()` column or a missing inverse passes
  `typecheck` and `lint` and then fails at runtime — or worse, silently returns
  empty arrays. `src/db/relations.integration.test.ts` is the only thing that
  catches this; it needs the seeded database and runs in CI's Database job.
- **`one` is nullable by default**, so every `notNull` foreign key needs
  `optional: false` in `relations.ts`. Nothing cross-checks this against the
  column definition — get it wrong and the type lies about nullability.
- **Every `pgTable` _and_ every `pgEnum` must be exported from
  `src/db/schema/tables/index.ts`** — that barrel is what `drizzle.config.ts`
  reads. An unexported enum is still used as a column type, producing SQL that
  fails with `type "…" does not exist`.
- `storyTurns.selectedChoiceId` needs its explicit `AnyPgColumn` return type.
  Without it the mutual reference with `turnChoices` makes TypeScript fall back
  to `any` (TS7022).

---

## Where enforcement should live

Prefer, in order:

1. **The database**, when a CHECK or unique index can express it — as with pair
   ordering and one-self-per-user.
2. **A service function** that owns the write, so callers can't assemble an
   invalid row — the practical answer for everything in §3.
3. **This document**, for rules that are genuinely product-level (§1) or
   conventions (§6).

When something in §3 or §4 actually goes wrong in practice, that is the signal
to promote it from here into a constraint.
