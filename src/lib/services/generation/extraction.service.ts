import { db } from '@/index';
import { getGenerator } from '@/lib/ai';
import {
  ExtractionOutput,
  TranscriptMessage,
  extractionPrompt,
} from '@/lib/ai/prompts/extraction.prompt';
import * as persons from '../persons/persons.service';
import * as storylines from '../storylines/storylines.service';
import * as storylineWriter from '../storylines/storylines.writer';
import * as motifs from '../motifs/motifs.service';
import * as timelineWriter from '../timeline/timeline.writer';
import * as timelineReader from '../timeline/timeline.reader';
import { PublicStoryline } from '../storylines/storylines.types';
import { assembleUserContext } from './context.reader';
import { GenerationDeps } from './turns.service';

export type Transcript = {
  surface: string;
  messages: TranscriptMessage[];
};

/**
 * Turns a conversation into a storyline.
 *
 * The transcript is an argument and never a column. Nothing below writes a
 * message: what is persisted is the model's retelling, which is the shape the
 * on-device extraction will eventually produce too. invariants.md §1 calls this
 * the product's central claim, and notes that a breach of it looks identical to
 * correct data — so it is asserted in the tests rather than trusted here.
 *
 * Phased so no transaction is held across the model call:
 *
 *   0. create the storyline as `generating`, so there is something to show and
 *      something to mark failed
 *   1. read who the user already knows
 *   2. call the model
 *   3. write everything else in one transaction, ending `ready`
 *
 * A failure at step 2 or 3 marks the storyline `failed` with a reason, which is
 * the only state that carries one.
 */
export async function extractStoryline(
  userId: string,
  transcript: Transcript,
  deps: GenerationDeps = {}
): Promise<PublicStoryline> {
  const storyline = await storylines.createStoryline(userId, {
    title: 'Untitled',
    sourceSurface: transcript.surface,
  });
  await storylines.markStatus(userId, storyline.id, 'generating');

  try {
    const user = await assembleUserContext(userId);

    const generator = deps.generator ?? getGenerator();
    const { value } = await generator.run(extractionPrompt, {
      user,
      surface: transcript.surface,
      messages: transcript.messages,
    });

    return await persist(userId, storyline.id, value, new Set(user.persons.map((p) => p.id)));
  } catch (error) {
    // Status and reason are written together, through the one path that can
    // reach `failed` — invariants.md §4.
    await storylines.markFailed(
      userId,
      storyline.id,
      error instanceof Error ? error.message : 'Extraction failed'
    );
    throw error;
  }
}

async function persist(
  userId: string,
  storylineId: string,
  output: ExtractionOutput,
  knownPersonIds: Set<string>
): Promise<PublicStoryline> {
  await storylineWriter.setStorylineNarrative(userId, storylineId, {
    title: output.title,
    tone: output.tone,
    setting: output.setting ?? undefined,
  });

  // Persons are resolved before the transaction because they are user-scoped
  // rather than storyline-scoped: they outlive this story, and the get-or-create
  // they go through is itself idempotent.
  const personIdByName = new Map<string, string>();

  // The protagonist is the account holder, so they resolve to the one `isSelf`
  // row rather than becoming a second person named after them. invariants.md §5
  // requires exactly one per user and nothing else creates it; without this, the
  // reader would be cast as a stranger in their own story and cross-storyline
  // continuity would break for the one person it matters most for.
  const protagonist = output.cast.find((member) => member.role === 'protagonist');

  for (const member of output.cast) {
    const person =
      member === protagonist
        ? await persons.getOrCreateSelfPerson(userId, member.name)
        : await resolvePerson(userId, member, knownPersonIds);
    personIdByName.set(member.name, person.id);
  }

  // Structural relationships are between people, not characters, so they are
  // written outside the storyline too.
  for (const relationship of output.relationships) {
    const [aName, bName] = relationship.betweenNames;
    const a = personIdByName.get(aName);
    const b = personIdByName.get(bName);
    if (!a || !b || a === b || !relationship.relationshipType) continue;
    // Already recorded is not an error here: the same two people keep being the
    // same two people across every story they appear in.
    await persons.linkPersons(userId, a, b, relationship.relationshipType).catch(() => undefined);
  }

  const characterIdByName = new Map<string, string>();
  for (const member of output.cast) {
    const personId = personIdByName.get(member.name)!;
    const character = await storylines.castCharacter(userId, storylineId, personId, {
      role: member.role,
      description: member.description ?? undefined,
    });
    characterIdByName.set(member.name, character.id);
  }

  for (const relationship of output.relationships) {
    const [aName, bName] = relationship.betweenNames;
    const a = characterIdByName.get(aName);
    const b = characterIdByName.get(bName);
    if (!a || !b || a === b) continue;
    await storylines
      .relateCharacters(userId, storylineId, a, b, {
        closeness: relationship.closeness ?? undefined,
        tension: relationship.tension ?? undefined,
        powerBalance: relationship.powerBalance ?? undefined,
      })
      .catch(() => undefined);
  }

  // The timeline, background and the storyline becoming readable all commit
  // together: a `ready` storyline with half a timeline is worse than one that
  // never finished, because nothing marks it as incomplete.
  await db.transaction(async (tx) => {
    let order = 0;
    for (const beat of output.beats) {
      order += timelineReader.NARRATIVE_ORDER_GAP;
      await timelineWriter.insertEvent(tx, storylineId, order, {
        origin: 'extracted',
        title: beat.title,
        description: beat.description,
        stakes: beat.stakes ?? undefined,
        participantCharacterIds: beat.participantNames
          .map((name) => characterIdByName.get(name))
          .filter((id): id is string => id !== undefined),
      });
    }

    for (const entry of output.background) {
      await timelineWriter.insertContextEntry(tx, storylineId, {
        source: 'inferred',
        content: entry.content,
        characterId: entry.aboutName ? characterIdByName.get(entry.aboutName) : undefined,
      });
    }
  });

  for (const motif of output.motifs) {
    const participantIds = motif.participantNames
      .map((name) => personIdByName.get(name))
      .filter((id): id is string => id !== undefined);
    const created = await motifs
      .createMotif(
        userId,
        { label: motif.label, description: motif.description ?? undefined },
        participantIds
      )
      .catch(() => null);
    if (created) {
      await motifs.recordMotifOccurrence(userId, created.id, storylineId).catch(() => undefined);
    }
  }

  // Written here rather than left for the sweep. Extraction writes events, so a
  // storyline with no summary looks stale the moment it exists and would burn a
  // model call for a summary the extraction already produced.
  await storylineWriter.setArcSummaryIfUnchanged({
    storylineId,
    summary: output.arcSummary,
    watermark: new Date(),
    expected: null,
  });

  await storylines.markStatus(userId, storylineId, 'ready');

  return storylines.getStoryline(userId, storylineId);
}

/**
 * Finds or creates the `persons` row for one cast member.
 *
 * Three routes, in order of how much they preserve continuity:
 *
 * 1. An id the model matched against people the user already has. Checked
 *    against that set rather than trusted — a hallucinated id would otherwise
 *    attach this story to nobody, or to a row that is not the user's.
 * 2. A handle from the transcript, hashed. This is the mechanism that makes a
 *    person the same row across separate conversations, and the reason the same
 *    contact reached two ways does not become two people.
 * 3. A name alone, for someone mentioned but never heard from.
 */
async function resolvePerson(
  userId: string,
  member: ExtractionOutput['cast'][number],
  knownPersonIds: Set<string>
) {
  if (member.existingPersonId && knownPersonIds.has(member.existingPersonId)) {
    return persons.getPerson(userId, member.existingPersonId);
  }

  if (member.sourceHandle) {
    return persons.getOrCreatePersonByHandle(userId, member.sourceHandle, member.name);
  }

  return persons.createPerson(userId, {
    name: member.name,
    voiceProfile: member.voiceTone ? { tone: member.voiceTone } : undefined,
  });
}
