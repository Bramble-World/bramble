# Bramble — Application-Level Invariants

`reference.md` explains what each table means. This file lists the rules the
**database cannot enforce**, which the application must therefore guarantee
itself. Every entry here is something Postgres will happily let you violate.

Each rule notes how it fails, so it's clear whether a bug would be loud or
silent. The silent ones are the dangerous ones.

---

## 1. Privacy — the product-level rule

**Raw message content is never persisted.** Messages reach the LLM transiently
during generation and are never written to any column. This is the product's
central claim, not an implementation detail.

- `events.generationRationale` holds the model's _own reasoning_, never quoted
  source text.
- `persons.sourceContactRef` is a **one-way hash** of a phone number or email.
  Writing the raw value would look identical to the database.

**Fails:** silently, and as a privacy breach rather than a bug. Nothing detects
it. Worth an explicit check in code review of anything touching the generation
pipeline.

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
```

`lastActiveAt` is denormalised — it equals `MAX(storyTurns.respondedAt)` for the
session — and exists so the idle sweep is one indexed scan instead of a join and
aggregate over every session's turns. **Forget to touch it and a session looks
idle while someone is actively playing**, so the arc summary recomputes
underneath them.

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

- **`narrativeOrder` uses gaps of 10** (10, 20, 30…) so a mid-story insert can
  take 15 without renumbering. There is also **no uniqueness** on
  `(storylineId, narrativeOrder)`, so two beats can collide and order
  arbitrarily.
- **`storylineLinks` has no ordering CHECK**, deliberately — `sequel` is
  directional. The consequence is that `parallel` and `crossover`, where
  direction is meaningless, _can_ be stored twice reversed. Decide a convention
  if those get used.
- **`arcSummary` recompute dedup** is by comparing `arcSummaryGeneratedAt`
  against the newest event's `createdAt`. Nothing marks a session as already
  summarised, so a sweep that ignores this will recompute forever.

---

## 7. Drizzle traps specific to this repo

- `relations` imports from **`drizzle-orm/_relations`**, not `drizzle-orm`.
  Drizzle 1.0 moved the old API there; the root exports only the
  differently-shaped `defineRelations`. "Fixing" the import breaks the build.
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
