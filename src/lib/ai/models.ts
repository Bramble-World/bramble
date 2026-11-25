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

export type StageName = 'turn' | 'consequence' | 'extraction' | 'arc' | 'pool' | 'situations';

export type StageModel = {
  model: string;
  reasoningEffort: ReasoningEffort;
  /**
   * Asked for first at OpenAI's flex tier: Batch prices, about half, for an
   * answer that may be slower or refused when the provider is busy. A refusal,
   * or no answer within `withinMs`, is asked again at the normal tier once, so
   * flex only ever makes a call cheaper, never fail. Only for stages nobody
   * waits on; a streamed call (the beat) is always at the normal tier.
   *
   * Offered for gpt-6-astra but not GPT-6.2 or later models, so it goes when
   * the model changes (https://developers.openai.com/api/docs/guides/flex-processing).
   */
  flex?: { withinMs: number };
};

/**
 * Starting points, not tuned values. The interactive stages sit lower because
 * the user is waiting; the batch stages sit higher because they run once and
 * everything downstream inherits their quality.
 */
export const STAGE_MODELS: Record<StageName, StageModel> = {
  turn: { model: DEFAULT_MODEL, reasoningEffort: 'low' },
  // Settled after the beat, so nobody waits on it, but the next beat should see
  // it: flex gets 20 s (the normal tier takes about 13) before the normal tier
  // is asked, well inside the 90 s consequence lease.
  consequence: { model: DEFAULT_MODEL, reasoningEffort: 'medium', flex: { withinMs: 20_000 } },
  // Lowered from 'high'. Extraction is the one stage whose output grew several
  // times over — up to 20 beats, 12 cast, 16 relationships — and reasoning time
  // grows with it. At 'high' a dense conversation took longer to generate than
  // the HTTP client would wait for a single header, and failed with nothing to
  // show for it. Effort is the cheapest dial that buys the margin back.
  extraction: { model: DEFAULT_MODEL, reasoningEffort: 'medium' },
  arc: { model: DEFAULT_MODEL, reasoningEffort: 'medium', flex: { withinMs: 120_000 } },
  // Writing and checking pool stories. Off the request path, so there is no
  // header timeout to fit inside, and these decide what every other player gets.
  pool: { model: DEFAULT_MODEL, reasoningEffort: 'high', flex: { withinMs: 180_000 } },
  // Sorting a link from ChatGPT into situations to write. On the request path,
  // and it decides what is too sensitive to keep, so not the lowest.
  situations: { model: DEFAULT_MODEL, reasoningEffort: 'medium' },
};
