/**
 * Which model each stage talks to.
 *
 * One place, because tuning means changing these and nothing else. The
 * generation code never names a model; it names a stage.
 *
 * `gpt-6-astra` is a reasoning model by the provider's own rule — every gpt-5+
 * non-chat model is — and two consequences follow that are worth stating, since
 * both are silent rather than errors:
 *
 * - **No `temperature`.** The provider reports `supportsNonReasoningParameters:
 *   false` for gpt-6 and later, so sampling parameters are dropped with a
 *   warning rather than applied. Narrative variety has to come from the prompt.
 * - **The system prompt is sent as a `developer` message**, not a `system` one.
 *   The provider does that automatically for reasoning models; it is mentioned
 *   here so the behaviour is not mistaken for a bug when reading a request log.
 */
export const DEFAULT_MODEL = 'gpt-6-astra';

/**
 * How hard the model thinks. gpt-6 and later accept low through max; the
 * provider rejects `none` for astra, which is why it is absent here.
 *
 * Effort is the main cost and latency dial now that temperature is unavailable,
 * so it is set per stage rather than globally: the turn loop runs on every click
 * and extraction runs once.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type StageName = 'turn' | 'consequence' | 'extraction' | 'arc';

export type StageModel = {
  model: string;
  reasoningEffort: ReasoningEffort;
};

/**
 * Starting points, not tuned values. The interactive stages sit lower because
 * the user is waiting; the batch stages sit higher because they run once and
 * everything downstream inherits their quality.
 */
export const STAGE_MODELS: Record<StageName, StageModel> = {
  turn: { model: DEFAULT_MODEL, reasoningEffort: 'low' },
  consequence: { model: DEFAULT_MODEL, reasoningEffort: 'medium' },
  // Lowered from 'high'. Extraction is the one stage whose output grew several
  // times over — up to 20 beats, 12 cast, 16 relationships — and reasoning time
  // grows with it. At 'high' a dense conversation took longer to generate than
  // the HTTP client would wait for a single header, and failed with nothing to
  // show for it. Effort is the cheapest dial that buys the margin back.
  extraction: { model: DEFAULT_MODEL, reasoningEffort: 'medium' },
  arc: { model: DEFAULT_MODEL, reasoningEffort: 'medium' },
};
