import { db } from '@/index';
import { getGenerator } from '@/lib/ai';
import {
  ExtractionOutput,
  TranscriptMessage,
  extractionPrompt,
} from '@/lib/ai/prompts/extraction.prompt';
import * as persons from '../persons/persons.service';
import * as personReader from '../persons/persons.reader';
import * as personWriter from '../persons/persons.writer';
import { hashContactHandle } from '../persons/persons.contact';
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
 * `GenerationDeps`, plus a hook for callers that must know the storyline id
 * before the work finishes.
 *
 * Only extraction has this, because only extraction creates the row it is
 * building — every other stage is handed one.
 */
export type ExtractionDeps = GenerationDeps & {
  onStorylineCreated?: (storylineId: string) => Promise<void>;
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
  deps: ExtractionDeps = {}
): Promise<PublicStoryline> {
  const storyline = await storylines.createStoryline(userId, {
    title: 'Untitled',
    sourceSurface: transcript.surface,
  });
  await storylines.markStatus(userId, storyline.id, 'generating');

  // Announced before the model call, not after it. The import worker uses this
  // to record which storyline it is building, so a crash part-way through is
  // recoverable rather than producing a second one on retry. Awaited, because a
  // caller that has not recorded it yet is in exactly the state this prevents.
  await deps.onStorylineCreated?.(storyline.id);

  try {
    const user = await assembleUserContext(userId);

    const generator = deps.generator ?? getGenerator();
    const { value } = await generator.run(
      extractionPrompt,
      {
        user,
        surface: transcript.surface,
        messages: transcript.messages,
      },
      { signal: deps.signal }
    );

    return await persist(
      userId,
      storyline.id,
      value,
      new Set(user.persons.map((p) => p.id)),
      transcript
    );
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
  knownPersonIds: Set<string>,
  transcript: Transcript
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

  // Built from the transcript rather than from the model's output, because the
  // model reports display names and only the transcript knows which handle sent
  // them. See `handlesBySender` for what "unambiguous" has to mean here.
  const handleBySender = handlesBySender(transcript);

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
        : await resolvePerson(userId, member, knownPersonIds, handleBySender);
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
      // Per storyline, not per person: the same human wants different things in
      // different stories, which is the whole reason characters and persons are
      // separate tables.
      want: member.want,
      avoids: member.avoids ?? undefined,
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
        occurredAt: parseOccurredAt(beat.occurredAt),
        participantCharacterIds: beat.participantNames
          .map((name) => characterIdByName.get(name))
          .filter((id): id is string => id !== undefined),
        engagementScore: beat.engagementScore,
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
 * Turns the model's date for a beat into one the column will take.
 *
 * `occurredAt` is when the beat happened in the world, which `narrativeOrder`
 * deliberately is not — the two differ whenever a story compresses or reorders,
 * and without a date a timeline cannot tell three weeks of silence from ten
 * minutes. The transcript carries real timestamps, so this is knowable; it was
 * simply never asked for.
 *
 * A model can return anything here, so an unparseable date becomes null rather
 * than an Invalid Date, which Postgres would reject and which would take the
 * whole extraction down over one bad string.
 */
function parseOccurredAt(value: string | null): Date | undefined {
  if (!value) return undefined;
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? undefined : when;
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
/**
 * Which transcript handle each sender name belongs to, where that is answerable.
 *
 * The map is deliberately incomplete. A name earns a handle only when the
 * transcript is unambiguous about it, because the alternative to "no handle" is
 * not "a guess" — it is two different people sharing one `persons` row, which
 * looks like valid data forever and is a privacy failure rather than a bug.
 *
 * Three rules, each for a real input shape:
 *
 * - **One handle per name.** A name that appears under two handles is two people
 *   the transcript happens to label the same, which is exactly the case that
 *   caused this: two conversations each had a "Person A", and hashing the name
 *   merged a Lauren and an Ollie.
 * - **One name per handle.** A group thread that puts every message under the
 *   thread's own id would otherwise give every participant the same hash and
 *   collapse the whole cast into one person.
 * - **No placeholders.** The dev lab imports CSVs where `handle` may be `them`,
 *   `me` or empty. Those are not identities, and hashing them would make every
 *   CSV-imported contact the same person.
 */
function handlesBySender(transcript: Transcript): Map<string, string> {
  const PLACEHOLDERS = new Set(['me', 'them', '']);

  const handlesForName = new Map<string, Set<string>>();
  const namesForHandle = new Map<string, Set<string>>();

  for (const message of transcript.messages) {
    // The reader is resolved through `getOrCreateSelfPerson`, never by handle,
    // so their messages say nothing about anyone in the cast.
    if (message.isFromMe) continue;

    const handle = message.handle?.trim().toLowerCase() ?? '';
    const name = message.sender?.trim() ?? '';
    if (!name || PLACEHOLDERS.has(handle)) continue;

    handlesForName.set(name, (handlesForName.get(name) ?? new Set()).add(handle));
    namesForHandle.set(handle, (namesForHandle.get(handle) ?? new Set()).add(name));
  }

  const resolved = new Map<string, string>();
  for (const [name, handles] of handlesForName) {
    if (handles.size !== 1) continue;
    const [handle] = [...handles];
    if (namesForHandle.get(handle)?.size !== 1) continue;
    resolved.set(name, handle);
  }
  return resolved;
}

/**
 * Finds or creates the `persons` row for one cast member.
 *
 * **Identity is the handle, never the name.** The model is asked for
 * `sourceHandle` as "the exact name this person sent messages under", so what it
 * returns is a display name — and hashing that merged two people who were each
 * labelled "Person A" in separate conversations into one row. The name is now
 * only a key into the transcript; the thing that gets hashed is the handle the
 * client sent, which is a stable per-person pseudonym.
 *
 * The order of the checks is the fix. `existingPersonId` is the model's opinion
 * and the handle is a fact, so when the two disagree the handle wins: a model
 * that recognises the wrong person must not be able to merge two humans.
 */
async function resolvePerson(
  userId: string,
  member: ExtractionOutput['cast'][number],
  knownPersonIds: Set<string>,
  handleBySender: Map<string, string>
) {
  const voiceProfile = member.voiceTone ? { tone: member.voiceTone } : undefined;
  const handle = member.sourceHandle ? handleBySender.get(member.sourceHandle) : undefined;

  if (handle) {
    const ref = hashContactHandle(handle);

    // (a) Known by their handle already. This is the identity that matters, and
    // it outranks whatever the model thought: `existingPersonId` is ignored
    // here precisely so a misrecognition cannot merge two different people.
    const byHandle = await personReader.getPersonByContactRef(userId, ref);
    if (byHandle) return persons.ensureVoiceProfile(userId, byHandle, voiceProfile);

    // (b) Someone previously only mentioned, now heard from for the first time.
    // They have a row and no handle, so this is the moment that row earns one —
    // and claiming it is better than creating a second person for someone the
    // model correctly recognised.
    if (member.existingPersonId && knownPersonIds.has(member.existingPersonId)) {
      const known = await persons.getPerson(userId, member.existingPersonId);
      if (!known.isSelf) {
        const claimed = await personWriter.setContactRefIfAbsent(userId, known.id, ref);
        if (claimed) return persons.ensureVoiceProfile(userId, claimed, voiceProfile);
      }
    }

    // (c) Nobody we know. The handle creates the row, so the next conversation
    // this person appears in finds them.
    return persons.getOrCreatePersonByHandle(userId, handle, member.name, voiceProfile);
  }

  // No usable handle: mentioned but never heard from, or a transcript too
  // ambiguous to be trusted. Unchanged behaviour — the model's recognition is
  // the only signal left, and a name-only row carries no ref to collide with.
  if (member.existingPersonId && knownPersonIds.has(member.existingPersonId)) {
    const known = await persons.getPerson(userId, member.existingPersonId);
    return persons.ensureVoiceProfile(userId, known, voiceProfile);
  }

  return persons.createPerson(userId, { name: member.name, voiceProfile });
}
