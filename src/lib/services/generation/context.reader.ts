import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@/index';
import { personRelationships } from '@/db/schema/tables';
import { NotFoundError } from '@/lib/utils/errors';
import {
  BeatContext,
  RelationshipContext,
  SessionContext,
  StorylineContext,
  UserContext,
} from './generation.types';

/**
 * Assembles everything a prompt needs to know about a storyline.
 *
 * Plain functions returning plain data, composed at the call site rather than
 * merged into one reader with an options bag — that is what stops this becoming
 * the object every stage reaches into for whatever it needs next.
 *
 * Never called inside a transaction. These are reads, and a model call follows
 * them; holding a transaction open across one is the thing the whole pipeline is
 * arranged to avoid.
 */
export async function assembleStorylineContext(
  userId: string,
  storylineId: string
): Promise<StorylineContext> {
  // One nested read. This is what PR #22's relational graph was for; the
  // alternative is six hand-written joins that drift apart.
  const storyline = await db.query.storylines.findFirst({
    where: { id: storylineId, userId },
    with: {
      characters: { with: { person: true } },
      relationships: {
        with: { states: { with: { event: true } } },
      },
      events: {
        with: { participants: true },
        orderBy: { narrativeOrder: 'asc' },
      },
      contextEntries: true,
      motifOccurrences: { with: { motif: { with: { persons: true } } } },
    },
  });

  if (!storyline) throw new NotFoundError('Storyline', storylineId);

  const characters = storyline.characters.map((character) => ({
    id: character.id,
    personId: character.personId,
    name: character.person.name,
    role: character.role,
    description: character.description,
    // Resolved once, here. A storyline-specific voice wins over the person's
    // canonical one; everything downstream just reads `voice`.
    voice: character.voiceProfileOverride ?? character.person.voiceProfile ?? null,
    isSelf: character.person.isSelf,
  }));

  const relationships = await withStructuralTypes(
    userId,
    characters,
    storyline.relationships.map((relationship): RelationshipContext => {
      // "Current" means the state attached to the latest beat, by the order the
      // story is told in — not by when the row was written. Defining it in one
      // place is the point of this layer.
      const latest = [...relationship.states].sort(
        (a, b) => b.event.narrativeOrder - a.event.narrativeOrder
      )[0];

      return {
        id: relationship.id,
        characterAId: relationship.characterAId,
        characterBId: relationship.characterBId,
        relationshipType: null,
        baselineDynamic: relationship.baselineDynamic ?? null,
        currentDynamic: latest?.dynamic ?? null,
      };
    })
  );

  const timeline: BeatContext[] = storyline.events.map((event) => ({
    id: event.id,
    narrativeOrder: event.narrativeOrder,
    title: event.title,
    description: event.description,
    stakes: event.stakes,
    origin: event.origin,
    occurredAt: event.occurredAt?.toISOString() ?? null,
    participantCharacterIds: event.participants.map((c) => c.id),
  }));

  const byCharacterId: Record<string, string[]> = {};
  const storylineLevel: string[] = [];
  for (const entry of storyline.contextEntries) {
    if (entry.characterId) {
      (byCharacterId[entry.characterId] ??= []).push(entry.content);
    } else {
      storylineLevel.push(entry.content);
    }
  }

  // A motif can recur in one storyline through several beats; the prompt only
  // needs to know it is in play.
  const motifs = [
    ...new Map(
      storyline.motifOccurrences.map((occurrence) => [
        occurrence.motif.id,
        {
          id: occurrence.motif.id,
          label: occurrence.motif.label,
          description: occurrence.motif.description,
          personIds: occurrence.motif.persons.map((p) => p.id),
        },
      ])
    ).values(),
  ];

  return {
    storyline: {
      id: storyline.id,
      title: storyline.title,
      setting: storyline.setting,
      tone: storyline.tone,
      arcSummary: storyline.arcSummary,
    },
    characters,
    relationships,
    timeline,
    background: { storylineLevel, byCharacterId },
    motifs,
  };
}

/**
 * Fills in `relationshipType` from `personRelationships`.
 *
 * Separate query because the structural fact lives on the *persons* behind the
 * characters, deliberately: two people are siblings regardless of which story
 * you are reading. Joining it in the nested read above is not possible, since
 * the relation runs through a different pair of ids.
 */
async function withStructuralTypes(
  userId: string,
  characters: Array<{ id: string; personId: string }>,
  relationships: RelationshipContext[]
): Promise<RelationshipContext[]> {
  if (relationships.length === 0) return relationships;

  const personIdOf = new Map(characters.map((c) => [c.id, c.personId]));
  const personIds = [...new Set(characters.map((c) => c.personId))];
  if (personIds.length === 0) return relationships;

  const rows = await db
    .select({
      personAId: personRelationships.personAId,
      personBId: personRelationships.personBId,
      relationshipType: personRelationships.relationshipType,
    })
    .from(personRelationships)
    .where(
      and(
        eq(personRelationships.userId, userId),
        or(
          inArray(personRelationships.personAId, personIds),
          inArray(personRelationships.personBId, personIds)
        )
      )
    );

  // Pair tables store the ids sorted, so the lookup key is sorted too.
  const byPair = new Map(
    rows.map((r) => [[r.personAId, r.personBId].sort().join(':'), r.relationshipType])
  );

  return relationships.map((relationship) => {
    const a = personIdOf.get(relationship.characterAId);
    const b = personIdOf.get(relationship.characterBId);
    if (!a || !b) return relationship;
    return {
      ...relationship,
      relationshipType: byPair.get([a, b].sort().join(':')) ?? null,
    };
  });
}

/** The decision loop so far, so a prompt does not offer the same choice twice. */
export async function assembleSessionContext(
  userId: string,
  sessionId: string
): Promise<SessionContext> {
  const session = await db.query.storylineSessions.findFirst({
    where: { id: sessionId, userId },
    with: {
      turns: {
        orderBy: { turnOrder: 'asc' },
        with: { choices: { orderBy: { orderIndex: 'asc' } }, selectedChoice: true },
      },
    },
  });

  if (!session) throw new NotFoundError('Session', sessionId);

  return {
    sessionId: session.id,
    storylineId: session.storylineId,
    turns: session.turns.map((turn) => ({
      turnOrder: turn.turnOrder,
      narrativeContent: turn.narrativeContent,
      choices: turn.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        description: choice.description,
      })),
      selectedChoiceLabel: turn.selectedChoice?.label ?? null,
    })),
  };
}

/**
 * Who the user already knows.
 *
 * Extraction's input, and deliberately a different shape from
 * `StorylineContext` — it has no storyline to describe. Its job is to let the
 * model recognise someone it has seen before, so a person appearing in a second
 * transcript is matched to the existing row rather than duplicated.
 */
export async function assembleUserContext(userId: string): Promise<UserContext> {
  const [persons, motifs] = await Promise.all([
    db.query.persons.findMany({ where: { userId } }),
    db.query.motifs.findMany({ where: { userId } }),
  ]);

  const self = persons.find((p) => p.isSelf);

  return {
    userId,
    self: self ? { id: self.id, name: self.name } : null,
    // sourceContactRef is not projected. It is a hash, it is useless to a
    // prompt, and the model has no business seeing contact identifiers at all.
    persons: persons.map((person) => ({
      id: person.id,
      name: person.name,
      voice: person.voiceProfile ?? null,
    })),
    motifs: motifs.map((motif) => ({
      id: motif.id,
      label: motif.label,
      description: motif.description,
    })),
  };
}
