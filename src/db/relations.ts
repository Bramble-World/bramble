import { defineRelations } from 'drizzle-orm';
import * as schema from './schema/tables';

/**
 * The relational graph behind `db.query.*`.
 *
 * drizzle 1.0 has two relational APIs and they are wired to different places.
 * Passing `schema` to `drizzle()` populates `db._query.*` from the older
 * `relations()` helper, which now lives at `drizzle-orm/_relations`; passing
 * `relations` populates `db.query.*` from this file. The underscore on both the
 * module and the property is the library telling you which one it intends to
 * keep, so the read layer is built on this one.
 *
 * Three things differ from the older helper and shape how this file reads:
 *
 * - A relation is declared once, on the side that owns the foreign key. The
 *   inverse is inferred. Where two tables are joined more than once and the
 *   inference would be ambiguous, both ends carry a matching `alias`.
 * - `one` is nullable by default, so `optional: false` marks the FKs that are
 *   `notNull`. This is the only place that nullability is restated, so it has to
 *   agree with the column definitions.
 * - `through` traverses a junction table without surfacing it. Both junctions
 *   here are pure — composite primary key, no payload — so nothing is lost by
 *   hiding them, and `eventParticipants` / `motifParticipants` deliberately get
 *   no relations of their own. Nobody should be reading their rows directly.
 *
 * Relations can also carry a `where` filter, which would let a relation exclude
 * soft-deleted rows on its own. None do. `users` is the only soft-deleting
 * table, and a storyline whose owner was deleted should read as a storyline with
 * a deleted owner, not as a storyline with no owner. Filtering belongs at the
 * query, where it is visible.
 */
export const relations = defineRelations(schema, (r) => ({
  users: {
    storylines: r.many.storylines(),
    persons: r.many.persons(),
    motifs: r.many.motifs(),
    personRelationships: r.many.personRelationships(),
    sessions: r.many.storylineSessions(),
  },

  persons: {
    user: r.one.users({
      from: r.persons.userId,
      to: r.users.id,
      optional: false,
    }),
    // One person, many storylines — the split this whole model is built around.
    characters: r.many.characters(),
    // Pair tables store the two sides in sorted order, so neither column means
    // "subject". Both sides are exposed and callers check both.
    relationshipsAsA: r.many.personRelationships({ alias: 'personA' }),
    relationshipsAsB: r.many.personRelationships({ alias: 'personB' }),
    motifs: r.many.motifs({
      from: r.persons.id.through(r.motifParticipants.personId),
      to: r.motifs.id.through(r.motifParticipants.motifId),
    }),
  },

  personRelationships: {
    user: r.one.users({
      from: r.personRelationships.userId,
      to: r.users.id,
      optional: false,
    }),
    personA: r.one.persons({
      from: r.personRelationships.personAId,
      to: r.persons.id,
      optional: false,
      alias: 'personA',
    }),
    personB: r.one.persons({
      from: r.personRelationships.personBId,
      to: r.persons.id,
      optional: false,
      alias: 'personB',
    }),
  },

  storylines: {
    user: r.one.users({
      from: r.storylines.userId,
      to: r.users.id,
      optional: false,
    }),
    characters: r.many.characters(),
    relationships: r.many.characterRelationships(),
    events: r.many.events(),
    contextEntries: r.many.contextEntries(),
    motifOccurrences: r.many.motifOccurrences(),
    sessions: r.many.storylineSessions(),
    // Direction is meaningful for a sequel and meaningless for a crossover, so
    // both ends stay reachable and the link's own type says how to read it.
    linksFrom: r.many.storylineLinks({ alias: 'storylineA' }),
    linksTo: r.many.storylineLinks({ alias: 'storylineB' }),
  },

  storylineLinks: {
    storylineA: r.one.storylines({
      from: r.storylineLinks.storylineAId,
      to: r.storylines.id,
      optional: false,
      alias: 'storylineA',
    }),
    storylineB: r.one.storylines({
      from: r.storylineLinks.storylineBId,
      to: r.storylines.id,
      optional: false,
      alias: 'storylineB',
    }),
  },

  characters: {
    storyline: r.one.storylines({
      from: r.characters.storylineId,
      to: r.storylines.id,
      optional: false,
    }),
    person: r.one.persons({
      from: r.characters.personId,
      to: r.persons.id,
      optional: false,
    }),
    relationshipsAsA: r.many.characterRelationships({ alias: 'characterA' }),
    relationshipsAsB: r.many.characterRelationships({ alias: 'characterB' }),
    contextEntries: r.many.contextEntries(),
    events: r.many.events({
      from: r.characters.id.through(r.eventParticipants.characterId),
      to: r.events.id.through(r.eventParticipants.eventId),
    }),
  },

  characterRelationships: {
    storyline: r.one.storylines({
      from: r.characterRelationships.storylineId,
      to: r.storylines.id,
      optional: false,
    }),
    characterA: r.one.characters({
      from: r.characterRelationships.characterAId,
      to: r.characters.id,
      optional: false,
      alias: 'characterA',
    }),
    characterB: r.one.characters({
      from: r.characterRelationships.characterBId,
      to: r.characters.id,
      optional: false,
      alias: 'characterB',
    }),
    states: r.many.relationshipStates(),
  },

  relationshipStates: {
    relationship: r.one.characterRelationships({
      from: r.relationshipStates.relationshipId,
      to: r.characterRelationships.id,
      optional: false,
    }),
    // Every state change is attributed to the event that caused it. There is no
    // such thing as a state that just drifted.
    event: r.one.events({
      from: r.relationshipStates.eventId,
      to: r.events.id,
      optional: false,
    }),
  },

  events: {
    storyline: r.one.storylines({
      from: r.events.storylineId,
      to: r.storylines.id,
      optional: false,
    }),
    // Null for extracted events; set for the ones a decision produced, which is
    // the only record of why a generated beat exists.
    triggeredByTurn: r.one.storyTurns({
      from: r.events.triggeredByTurnId,
      to: r.storyTurns.id,
    }),
    participants: r.many.characters({
      from: r.events.id.through(r.eventParticipants.eventId),
      to: r.characters.id.through(r.eventParticipants.characterId),
    }),
    relationshipStates: r.many.relationshipStates(),
    motifOccurrences: r.many.motifOccurrences(),
  },

  contextEntries: {
    storyline: r.one.storylines({
      from: r.contextEntries.storylineId,
      to: r.storylines.id,
      optional: false,
    }),
    // Both null for storyline-wide context that belongs to no one character and
    // was not produced by a decision.
    character: r.one.characters({
      from: r.contextEntries.characterId,
      to: r.characters.id,
    }),
    triggeredByTurn: r.one.storyTurns({
      from: r.contextEntries.triggeredByTurnId,
      to: r.storyTurns.id,
    }),
  },

  storylineSessions: {
    storyline: r.one.storylines({
      from: r.storylineSessions.storylineId,
      to: r.storylines.id,
      optional: false,
    }),
    user: r.one.users({
      from: r.storylineSessions.userId,
      to: r.users.id,
      optional: false,
    }),
    turns: r.many.storyTurns(),
  },

  storyTurns: {
    session: r.one.storylineSessions({
      from: r.storyTurns.sessionId,
      to: r.storylineSessions.id,
      optional: false,
    }),
    // storyTurns joins turnChoices twice, so the offered-options side is paired
    // by alias. The chosen-option side names its own columns and needs none.
    choices: r.many.turnChoices({ alias: 'turnChoices' }),
    // Null while the turn is still awaiting an answer.
    selectedChoice: r.one.turnChoices({
      from: r.storyTurns.selectedChoiceId,
      to: r.turnChoices.id,
    }),
    triggeredEvents: r.many.events(),
    triggeredContextEntries: r.many.contextEntries(),
  },

  turnChoices: {
    turn: r.one.storyTurns({
      from: r.turnChoices.turnId,
      to: r.storyTurns.id,
      optional: false,
      alias: 'turnChoices',
    }),
  },

  motifs: {
    user: r.one.users({
      from: r.motifs.userId,
      to: r.users.id,
      optional: false,
    }),
    persons: r.many.persons({
      from: r.motifs.id.through(r.motifParticipants.motifId),
      to: r.persons.id.through(r.motifParticipants.personId),
    }),
    occurrences: r.many.motifOccurrences(),
  },

  motifOccurrences: {
    motif: r.one.motifs({
      from: r.motifOccurrences.motifId,
      to: r.motifs.id,
      optional: false,
    }),
    storyline: r.one.storylines({
      from: r.motifOccurrences.storylineId,
      to: r.storylines.id,
      optional: false,
    }),
    // A motif can recur in a storyline without being pinned to one event.
    event: r.one.events({
      from: r.motifOccurrences.eventId,
      to: r.events.id,
    }),
  },
}));
