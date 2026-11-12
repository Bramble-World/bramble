/**
 * How a story ended, as stored on its session.
 *
 * Key choices are stored as references, not text: which answered turn, and the
 * model's "you …" rewording of what was chosen there. The colour (`position`)
 * is read from the turn when the view is built, so it can never disagree with
 * the choice the reader actually made.
 */
export type StoredEnding = {
  title: string;
  summary: string;
  keyChoices: Array<{ turnId: string; label: string }>;
  /** Story nights it spanned, as the model read them. Null when it couldn't tell. */
  storyNights: number | null;
  /** The people the reader met, by name, when it ended. */
  peopleMet: string[];
};
