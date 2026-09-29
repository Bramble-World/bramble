import { BeatContext, RelationshipContext, StorylineContext } from './generation.types';

/**
 * The storyline as one playthrough has actually experienced it.
 *
 * A storyline extracted from a real conversation carries the whole of that
 * conversation, including the parts the reader has not reached. Handing all of
 * it to the turn prompt and asking for "the next beat" gives the model a script
 * to walk: in a real seven-turn session every narrative mapped onto the next
 * extracted beat and quoted its date, and in a twenty-turn session the last turn
 * narrated the final beat verbatim. The characters could not act, because
 * everything they might do had already been written down.
 *
 * So the cut is not a token-budget optimisation. It is the difference between a
 * story the reader is moving through and a transcript being read aloud to them.
 *
 * Pure and non-mutating by construction: the unfiltered context is shared with
 * the arc and consequence stages, which need all of it, and a cut that reached
 * back into that object would narrow their view too.
 */
export function contextAsOf(context: StorylineContext, playheadOrder: number): StorylineContext {
  const timeline = context.timeline.filter((beat) => beat.narrativeOrder <= playheadOrder);
  const met = charactersMet(context, timeline);

  return {
    ...context,
    timeline,
    // Anyone the reader has not met yet is not in the story yet. Without this
    // the cast list is a guest list for the whole conversation, and the model
    // was naming an investor in the first beat because extraction had described
    // him as "the investor who offers $300,000" and handed that over on turn one.
    characters: context.characters.filter((character) => met.has(character.id)),
    relationships: context.relationships
      // Both ends, or the row renders a name the reader has no way to place —
      // and `nameOf` would fall back to "someone", which is worse than absence.
      .filter((r) => met.has(r.characterAId) && met.has(r.characterBId))
      .map((relationship) => dynamicAsOf(relationship, playheadOrder)),
  };
}

/**
 * Who the reader has met.
 *
 * Membership is earned by appearing in a beat they have reached — the same cut
 * as the timeline, applied to the people in it. The protagonist is always in:
 * the reader is present at their own story even in a beat that does not list
 * them.
 *
 * A character who is never a participant in any beat therefore never appears.
 * That is the honest outcome — someone mentioned but never present is not in
 * the story — but it is a behaviour change worth knowing about, because
 * extraction decides who counts as a participant.
 */
function charactersMet(context: StorylineContext, reached: BeatContext[]): Set<string> {
  return metCharacterIds(context.characters, reached);
}

/**
 * The membership rule itself, over the smallest shape that can express it.
 *
 * Exported and row-agnostic because the API needs the same answer from database
 * rows, not from a prompt-shaped `StorylineContext`. Duplicating the rule there
 * would let the map and the prompt disagree about who the reader has met — and
 * the whole point of the rule is that a person the reader has not met has
 * nothing to say yet, so two answers means one screen leaks what the other
 * hides.
 *
 * Takes already-reached beats rather than a playhead, so the caller decides what
 * "reached" means. `contextAsOf` cuts by `narrativeOrder`; a client-facing read
 * cuts by the furthest playhead across that user's sessions, which is not the
 * same number.
 */
export function metCharacterIds(
  characters: ReadonlyArray<{ id: string; isSelf: boolean }>,
  reached: ReadonlyArray<{ participantCharacterIds: string[] }>
): Set<string> {
  const met = new Set(reached.flatMap((beat) => beat.participantCharacterIds));
  for (const character of characters) {
    if (character.isSelf) met.add(character.id);
  }
  return met;
}

/**
 * Relationships leak the future the same way the timeline does, more quietly.
 *
 * `currentDynamic` is resolved from the highest-ordered state, which can belong
 * to a beat the reader has not reached, and it renders into the turn prompt
 * under "Between them". Left alone, the model is told how two people end up
 * feeling about each other before the story has got them there.
 */
function dynamicAsOf(
  relationship: RelationshipContext,
  playheadOrder: number
): RelationshipContext {
  const reached = relationship.states.filter((state) => state.narrativeOrder <= playheadOrder);
  return {
    ...relationship,
    // Falls back to null rather than to the baseline: the prompt already prefers
    // `currentDynamic ?? baselineDynamic`, and collapsing them here would lose
    // the distinction between "nothing has moved yet" and "this is where it
    // started".
    currentDynamic: reached.at(-1)?.dynamic ?? null,
    states: reached,
  };
}

/**
 * True when the source conversation has been used up.
 *
 * Takes the **unfiltered** context on purpose — it is a question about the
 * future, which the filtered one has been built not to know.
 *
 * Only `extracted` beats count. Generated beats are the playthrough's own
 * output, and treating those as remaining script would mean a session could
 * never be told it had left the real conversation behind.
 */
export function scriptExhausted(context: StorylineContext, playheadOrder: number): boolean {
  return !context.timeline.some(
    (beat) => beat.origin === 'extracted' && beat.narrativeOrder > playheadOrder
  );
}
