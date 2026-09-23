/**
 * Seeds the local database from the prototype's demo content.
 *
 * Run with `pnpm db:seed`. Idempotent: it deletes the seed user first, which
 * cascades through every downstream table, then rebuilds. Safe to run repeatedly.
 *
 * Note what is NOT written: `Scenario.history` holds raw message text, and
 * Bramble never persists that — there is no column for it and there should not
 * be. The seed uses the surrounding metadata (persona, stakes, voice) instead,
 * which is exactly the shape the real extraction pipeline will produce.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../../index';
import {
  characterRelationships,
  characters,
  contextEntries,
  eventParticipants,
  events,
  motifOccurrences,
  motifParticipants,
  motifs,
  personRelationships,
  persons,
  relationshipStates,
  storylineLinks,
  storylineSessions,
  storyTurns,
  storylines,
  turnChoices,
  users,
} from '../schema/tables';
import { MAIN_CHARACTER, SCENARIOS } from '../../lib/demo/scenarios';
import { sequenceFor } from '../../lib/demo/story-beats';

const SEED_CLERK_ID = 'user_seed_demo';
const SEED_EMAIL = 'seed@bramble.local';

/**
 * Arc summaries are backdated so the fixture is realistic: a summary is computed
 * when a storyline is generated, and the session that adds conversation_generated
 * events happens afterwards — which leaves it stale and due for recompute.
 *
 * Backdating is also the only way to express that inside one transaction, since
 * Postgres `now()` is transaction-start time and constant throughout, so every
 * created_at in this seed is identical.
 */
const SUMMARY_COMPUTED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000);

/** Pair tables carry CHECK (aId < bId); callers must sort before writing. */
const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const { hostname } = new URL(url);
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error(
      `Refusing to seed ${hostname}. This script deletes and rewrites data and is for local use only.`
    );
  }
}

async function seed() {
  assertLocalDatabase();

  await db.transaction(async (tx) => {
    // Cascades clear persons, storylines, characters, sessions, turns, motifs…
    await tx.delete(users).where(eq(users.clerkId, SEED_CLERK_ID));

    const [user] = await tx
      .insert(users)
      .values({ clerkId: SEED_CLERK_ID, email: SEED_EMAIL, emailVerifiedAt: new Date() })
      .returning({ id: users.id });

    // The account holder, represented as a person so they can be cast as a
    // character and appear in relationships like anyone else.
    const [self] = await tx
      .insert(persons)
      .values({
        userId: user.id,
        name: MAIN_CHARACTER.name,
        isSelf: true,
        voiceProfile: { tone: 'candid, a little self-deprecating' },
      })
      .returning({ id: persons.id });

    // One person per distinct persona across all scenarios — the same real
    // person is one row regardless of how many storylines they appear in.
    const personaNames = [...new Set(SCENARIOS.map((s) => s.personaName))];
    const personByName = new Map<string, string>();

    for (const name of personaNames) {
      const source = SCENARIOS.find((s) => s.personaName === name)!;
      const [row] = await tx
        .insert(persons)
        .values({
          userId: user.id,
          name,
          voiceProfile: { tone: source.voiceNotes },
        })
        .returning({ id: persons.id });
      personByName.set(name, row.id);

      const [a, b] = pair(self.id, row.id);
      await tx
        .insert(personRelationships)
        .values({
          userId: user.id,
          personAId: a,
          personBId: b,
          relationshipType: source.nodeCaption,
        })
        .onConflictDoNothing();
    }

    const storylineByScenarioId = new Map<string, string>();

    for (const scenario of SCENARIOS) {
      const [storyline] = await tx
        .insert(storylines)
        .values({
          userId: user.id,
          title: scenario.title,
          sourceSurface: scenario.surface === 'email' ? 'email' : 'imessage',
          tone: scenario.genre,
          status: 'ready',
          arcSummary: scenario.unresolved,
          arcSummaryGeneratedAt: SUMMARY_COMPUTED_AT,
        })
        .returning({ id: storylines.id });

      storylineByScenarioId.set(scenario.id, storyline.id);

      const [protagonist] = await tx
        .insert(characters)
        .values({ storylineId: storyline.id, personId: self.id, role: 'protagonist' })
        .returning({ id: characters.id });

      const [counterpart] = await tx
        .insert(characters)
        .values({
          storylineId: storyline.id,
          personId: personByName.get(scenario.personaName)!,
          role: 'supporting',
          description: scenario.relationship,
        })
        .returning({ id: characters.id });

      const [ca, cb] = pair(protagonist.id, counterpart.id);
      const [relationship] = await tx
        .insert(characterRelationships)
        .values({
          storylineId: storyline.id,
          characterAId: ca,
          characterBId: cb,
          baselineDynamic: { tension: scenario.stakes, closeness: scenario.nodeCaption },
        })
        .returning({ id: characterRelationships.id });

      // Canonical beats. narrativeOrder uses gaps of 1000 so later inserts can
      // take gap values without renumbering.
      const beats = [
        {
          title: 'Where things stood',
          description: scenario.stakes,
          dynamic: { closeness: scenario.nodeCaption, tension: scenario.stakes },
        },
        {
          title: 'What was left open',
          description: scenario.unresolved,
          dynamic: { closeness: 'strained', tension: scenario.unresolved },
        },
        {
          title: 'The silence',
          description: `${scenario.silenceDuration}.`,
          dynamic: { closeness: 'distant', tension: scenario.silenceDuration },
        },
      ];

      for (const [i, beat] of beats.entries()) {
        const [event] = await tx
          .insert(events)
          .values({
            storylineId: storyline.id,
            narrativeOrder: (i + 1) * 1000,
            title: beat.title,
            description: beat.description,
            origin: 'extracted',
            generationRationale: 'Seeded from the prototype scenario metadata.',
          })
          .returning({ id: events.id });

        await tx.insert(eventParticipants).values([
          { eventId: event.id, characterId: protagonist.id },
          { eventId: event.id, characterId: counterpart.id },
        ]);

        // A snapshot per beat, so "what was this relationship like at this
        // point" is reconstructable by walking events in narrativeOrder.
        await tx.insert(relationshipStates).values({
          relationshipId: relationship.id,
          eventId: event.id,
          dynamic: beat.dynamic,
        });
      }

      await tx.insert(contextEntries).values([
        { storylineId: storyline.id, content: scenario.relationship, source: 'inferred' },
        {
          storylineId: storyline.id,
          characterId: counterpart.id,
          content: scenario.voiceNotes,
          source: 'inferred',
        },
      ]);

      // The recurring references this story leans on. Motifs belong to the user,
      // not the storyline, so they are created once and linked per occurrence.
      for (const leaf of scenario.leaves.slice(0, 2)) {
        const [motif] = await tx
          .insert(motifs)
          .values({
            userId: user.id,
            label: leaf,
            description: `Recurring in "${scenario.title}".`,
          })
          .returning({ id: motifs.id });

        await tx.insert(motifParticipants).values([
          { motifId: motif.id, personId: self.id },
          { motifId: motif.id, personId: personByName.get(scenario.personaName)! },
        ]);
        await tx.insert(motifOccurrences).values({ motifId: motif.id, storylineId: storyline.id });
      }

      // One playthrough, replaying the prototype's scripted beats as turns.
      const [session] = await tx
        .insert(storylineSessions)
        .values({ storylineId: storyline.id, userId: user.id })
        .returning({ id: storylineSessions.id });

      const script = sequenceFor(scenario.id);
      const answeredTurnIds: string[] = [];

      for (const [i, beat] of script.entries()) {
        // Two-step write: the turn cannot name its choice until the choices exist.
        const [turn] = await tx
          .insert(storyTurns)
          .values({
            sessionId: session.id,
            turnOrder: (i + 1) * 10,
            narrativeContent: [beat.narration, beat.incomingMessage, beat.reaction]
              .filter(Boolean)
              .join('\n'),
          })
          .returning({ id: storyTurns.id });

        // A beat can legitimately have no options — the closing beat of a
        // script, or the generic fallback. drizzle rejects an empty values().
        const inserted = beat.choices.length
          ? await tx
              .insert(turnChoices)
              .values(
                beat.choices.map((choice, index) => ({
                  turnId: turn.id,
                  label: choice.text,
                  orderIndex: index + 1,
                }))
              )
              .returning({ id: turnChoices.id })
          : [];

        // Answer every turn but the last, so each session has somewhere to resume.
        if (i < script.length - 1 && inserted.length > 0) {
          await tx
            .update(storyTurns)
            .set({ selectedChoiceId: inserted[0].id, respondedAt: new Date() })
            .where(eq(storyTurns.id, turn.id));
          answeredTurnIds.push(turn.id);
        }
      }

      // Answering a turn must touch the session, or an idle sweep sees a stale
      // timestamp and recomputes the arc summary underneath an active player.
      await tx
        .update(storylineSessions)
        .set({ lastActiveAt: new Date() })
        .where(eq(storylineSessions.id, session.id));

      // Canon the user created by steering. These are the rows that make
      // conversation-steering traceable: origin marks them as generated rather
      // than extracted, and triggeredByTurnId names the exact decision.
      //
      // narrativeOrder deliberately uses a gap value — 1500 sits between the
      // seeded 1000 and 2000 — which is the whole point of the gap numbering.
      const [firstDecision] = answeredTurnIds;
      if (firstDecision) {
        const [generated] = await tx
          .insert(events)
          .values({
            storylineId: storyline.id,
            narrativeOrder: 1500,
            title: 'A different answer',
            description: `You said something you did not say the first time, and ${scenario.personaName} heard it.`,
            origin: 'conversation_generated',
            triggeredByTurnId: firstDecision,
            generationRationale:
              'Added to canon because the player chose to respond rather than stay silent.',
          })
          .returning({ id: events.id });

        await tx.insert(eventParticipants).values([
          { eventId: generated.id, characterId: protagonist.id },
          { eventId: generated.id, characterId: counterpart.id },
        ]);

        await tx.insert(relationshipStates).values({
          relationshipId: relationship.id,
          eventId: generated.id,
          dynamic: { closeness: 'unsettled', tension: 'Something was said that cannot be unsaid.' },
        });

        // Backstory the pipeline inferred during the session rather than during
        // the initial extraction — same lineage, mirrored on contextEntries.
        await tx.insert(contextEntries).values({
          storylineId: storyline.id,
          characterId: counterpart.id,
          content: `${scenario.personaName} has been waiting for this to be named out loud.`,
          source: 'conversation_generated',
          triggeredByTurnId: firstDecision,
        });
      }
    }

    // ---------------------------------------------------------------------
    // Sequels. Fabricated rather than drawn from the prototype, and the point
    // of them is continuity: each reuses the *same* persons row and creates a
    // new characters row, which is exactly the persistent/per-storyline split
    // the model exists for. Without one of these, nothing in the seed proves
    // a person can appear in two stories.
    // ---------------------------------------------------------------------
    const SEQUELS = [
      {
        after: 'unsent-apology',
        persona: 'Maya',
        title: 'What We Said Next',
        tone: 'Tentative reconciliation',
        arc: 'Started unreachable, ended talking honestly for the first time in months.',
        beats: [
          {
            title: 'She answered',
            description: 'The reply came the same evening, which neither of you expected.',
            dynamic: { closeness: 'cautious', tension: 'Nobody has mentioned the last fight.' },
          },
          {
            title: 'Saying the actual thing',
            description: 'The apology finally arrived without conditions attached to it.',
            dynamic: { closeness: 'warmer', tension: 'Whether it changes anything.' },
          },
        ],
      },
      {
        after: 'slow-fade',
        persona: 'Theo',
        title: 'The Reunion',
        tone: 'Old friends, new distance',
        arc: 'Started performative, ended with the friendship honestly renegotiated.',
        beats: [
          {
            title: 'In the same room again',
            description: 'Eighteen months of drifting, and a wedding puts you at one table.',
            dynamic: { closeness: 'polite', tension: 'Neither of you names the gap.' },
          },
          {
            title: 'The honest version',
            description: 'One of you finally says the friendship changed rather than pretending.',
            dynamic: { closeness: 'renegotiated', tension: 'What it looks like from here.' },
          },
        ],
      },
    ];

    for (const sequel of SEQUELS) {
      const [storyline] = await tx
        .insert(storylines)
        .values({
          userId: user.id,
          title: sequel.title,
          sourceSurface: 'imessage',
          tone: sequel.tone,
          status: 'ready',
          arcSummary: sequel.arc,
          arcSummaryGeneratedAt: SUMMARY_COMPUTED_AT,
        })
        .returning({ id: storylines.id });

      // Same persons, new characters — the continuity this exists to show.
      const [protagonist] = await tx
        .insert(characters)
        .values({ storylineId: storyline.id, personId: self.id, role: 'protagonist' })
        .returning({ id: characters.id });

      const [counterpart] = await tx
        .insert(characters)
        .values({
          storylineId: storyline.id,
          personId: personByName.get(sequel.persona)!,
          role: 'supporting',
          description: `Later than the first story, and both of you know it.`,
        })
        .returning({ id: characters.id });

      const [sa, sb] = pair(protagonist.id, counterpart.id);
      const [relationship] = await tx
        .insert(characterRelationships)
        .values({
          storylineId: storyline.id,
          characterAId: sa,
          characterBId: sb,
          baselineDynamic: { closeness: 'wary', tension: 'Everything left unsaid last time.' },
        })
        .returning({ id: characterRelationships.id });

      for (const [i, beat] of sequel.beats.entries()) {
        const [event] = await tx
          .insert(events)
          .values({
            storylineId: storyline.id,
            narrativeOrder: (i + 1) * 1000,
            title: beat.title,
            description: beat.description,
            origin: 'extracted',
            generationRationale: 'Seeded sequel, written for the fixture.',
          })
          .returning({ id: events.id });

        await tx.insert(eventParticipants).values([
          { eventId: event.id, characterId: protagonist.id },
          { eventId: event.id, characterId: counterpart.id },
        ]);
        await tx
          .insert(relationshipStates)
          .values({ relationshipId: relationship.id, eventId: event.id, dynamic: beat.dynamic });
      }

      const previous = storylineByScenarioId.get(sequel.after);
      if (previous) {
        // Directional: a sequel follows its predecessor, so order carries
        // meaning and storylineLinks deliberately has no ordering CHECK.
        await tx
          .insert(storylineLinks)
          .values({ storylineAId: previous, storylineBId: storyline.id, linkType: 'sequel' })
          .onConflictDoNothing();
      }
    }

    // Crossovers, derived rather than invented: scenarios sharing a hubLabel
    // are about the same part of the user's life. Unlike `sequel`, direction is
    // meaningless here, so ids are sorted to avoid storing a reversed duplicate
    // — the convention the schema cannot enforce for this table.
    const byHub = new Map<string, string[]>();
    for (const scenario of SCENARIOS) {
      const id = storylineByScenarioId.get(scenario.id);
      if (!id) continue;
      byHub.set(scenario.hubLabel, [...(byHub.get(scenario.hubLabel) ?? []), id]);
    }

    for (const ids of byHub.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = pair(ids[i], ids[j]);
          await tx
            .insert(storylineLinks)
            .values({ storylineAId: a, storylineBId: b, linkType: 'crossover' })
            .onConflictDoNothing();
        }
      }
    }
  });

  console.log('Seeded.');
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
