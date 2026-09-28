import { RelationshipContext, StorylineContext } from './generation.types';

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
  return {
    ...context,
    timeline: context.timeline.filter((beat) => beat.narrativeOrder <= playheadOrder),
    relationships: context.relationships.map((relationship) =>
      dynamicAsOf(relationship, playheadOrder)
    ),
  };
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
