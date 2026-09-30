import type { PublicPerson } from '@/lib/services/persons/persons.types';
import type { CharacterRole, PublicStoryline } from '@/lib/services/storylines/storylines.types';
import type { TurnWithChoices } from '@/lib/services/sessions/sessions.types';
import type { PublicImport } from '@/lib/services/imports/imports.types';
import { failureIsRetryable } from '@/lib/services/imports/imports.types';
import type {
  ArcView,
  ChoiceView,
  ImportView,
  PersonDetailView,
  PersonView,
  SessionStateView,
  SessionView,
  StorylineDetailView,
  TurnView,
} from './views.types';

/**
 * Pure functions from domain types to wire types.
 *
 * No database access, on purpose: it keeps them testable against plain object
 * literals, which is what makes the forbidden-key test in `views.test.ts` cheap
 * enough that it actually stays maintained. Anything needing a playhead read is
 * the service's job, not a view's — a view decides *shape*, never *visibility*.
 *
 * Every field is assigned. Never spread. See `views.types.ts` for why.
 */

/** ISO, or null. Dates never reach the client as `Date`. */
const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

export function personView(person: PublicPerson): PersonView {
  return {
    id: person.id,
    name: person.name,
    isSelf: person.isSelf,
  };
  // voiceProfile is deliberately absent: `sampleTurns` is model-authored
  // imitation of a real person's messages, shown to the person who received
  // them.
}

export function choiceView(choice: TurnWithChoices['choices'][number]): ChoiceView {
  return {
    id: choice.id,
    label: choice.label,
    description: choice.description,
  };
  // orderIndex is absent: the array order IS the order. Shipping both invites a
  // client that sorts by one and renders the other.
}

export function turnView(turn: TurnWithChoices): TurnView {
  return {
    id: turn.id,
    narrative: turn.narrativeContent,
    choices: turn.choices.map(choiceView),
  };
  // No selectedChoiceId or respondedAt: an open turn has neither by definition,
  // and including them would invite null-branching on the client for a state
  // that cannot occur.
}

export function arcView(
  storyline: PublicStoryline,
  role: CharacterRole = 'supporting',
  lastPlayedAt: Date | null = null
): ArcView {
  return {
    storylineId: storyline.id,
    title: storyline.title,
    setting: storyline.setting,
    tone: storyline.tone,
    role,
    lastPlayedAt: iso(lastPlayedAt),
    startable: storyline.status === 'ready',
  };
  // arcSummary is absent and must stay absent — it describes the whole arc
  // including unreached beats. failureReason is absent because it is
  // deliberately generic diagnostic text; the client renders a generic failure
  // from `startable`.
}

export function storylineDetailView(
  storyline: PublicStoryline,
  metCast: PublicPerson[]
): StorylineDetailView {
  return {
    id: storyline.id,
    title: storyline.title,
    setting: storyline.setting,
    tone: storyline.tone,
    startable: storyline.status === 'ready',
    cast: metCast.map(personView),
  };
  // No durationMinutes and no coverImageUrl. Neither has honest backing, and
  // with endless stories a duration cannot ever have one. Shipping a field the
  // client renders and then removing it is a breaking change; adding one later
  // is not.
}

export function personDetailView(input: {
  person: PublicPerson;
  relationshipType: string | null;
  arcs: Array<{ storyline: PublicStoryline; role: CharacterRole; lastPlayedAt: Date | null }>;
}): PersonDetailView {
  return {
    id: input.person.id,
    name: input.person.name,
    isSelf: input.person.isSelf,
    relationshipType: input.relationshipType,
    arcs: input.arcs.map((arc) => arcView(arc.storyline, arc.role, arc.lastPlayedAt)),
  };
  // No arc count as a separate field: the client has the array. A count that can
  // disagree with the list it summarises is a bug waiting for pagination.
}

export function importView(row: PublicImport): ImportView {
  return {
    id: row.id,
    conversationKey: row.conversationKey,
    status: row.status,
    stage: row.stage,
    storylineId: row.storylineId,
    // Flattened from two columns into one nullable object, because "failed with
    // no code" and "not failed" are the same thing to a client and a pair of
    // independently-nullable fields invites it to check the wrong one.
    failure: row.failureCode
      ? { code: row.failureCode, retryable: failureIsRetryable(row.failureCode) }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // startedAt is absent: it exists for the stall sweep, and a client that could
  // see it would be tempted to compute its own timeout from it.
}

export function sessionView(input: {
  id: string;
  storylineId: string;
  state: SessionStateView;
  turnsAnswered: number;
  turn: TurnWithChoices | null;
}): SessionView {
  return {
    id: input.id,
    storylineId: input.storylineId,
    state: input.state,
    turnsAnswered: input.turnsAnswered,
    turn: input.turn ? turnView(input.turn) : null,
  };
  // playheadOrder is absent: it is an internal key over events.narrativeOrder,
  // meaningless to a reader, and paired with any total it becomes a progress
  // figure that an endless story makes a lie.
}

export type * from './views.types';
