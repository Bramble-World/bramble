import {
  CONTEXT_ABOUT_MAX_CHARS,
  CONTEXT_DETAIL_MAX_CHARS,
  CONTEXT_MAX_PEOPLE,
  chatgptContextSchema,
  type ChatGPTContext,
} from './context';

/** The longest a person's name or relationship may be (`contextPersonSchema`). */
const SHORT_MAX_CHARS = 40;

/** What `fitSituation` had to do, by field: counts only, for the log. */
export type FitNote =
  | 'about'
  | 'people'
  | 'name'
  | 'relationship'
  | 'details'
  | 'you'
  | 'no_text'
  | 'no_people';

type RawPerson = { name?: string | null; relationship?: string | null; details?: string | null };
type RawSituation = {
  about?: string | null;
  people?: readonly (RawPerson | null | undefined)[] | null;
  you?: string | null;
};

/**
 * One situation from `chatgpt.situations`, made to fit what a story takes
 * (`chatgptContextSchema`), or null when there is nothing to write from.
 *
 * Trimmed, not dropped: a situation with a fourth person or a long sentence
 * about someone used to be thrown away whole, so a link full of real
 * situations answered "chatgpt didn't find a story there". Now it keeps the
 * first three people and shortens what's long at a sentence or word, and only
 * a situation with no text or no named person is dropped.
 */
export function fitSituation(raw: RawSituation): {
  context: ChatGPTContext | null;
  notes: FitNote[];
} {
  const notes: FitNote[] = [];
  const about = shorten(raw.about, CONTEXT_ABOUT_MAX_CHARS, () => notes.push('about'));
  if (!about) return { context: null, notes: [...notes, 'no_text'] };

  const named = (raw.people ?? []).flatMap((person) => {
    const name = shorten(person?.name, SHORT_MAX_CHARS, () => notes.push('name'));
    if (!name) return [];
    const relationship =
      shorten(person?.relationship, SHORT_MAX_CHARS, () => notes.push('relationship')) ||
      'someone in their life';
    const details = shorten(person?.details, CONTEXT_DETAIL_MAX_CHARS, () => notes.push('details'));
    return [{ name, relationship, details }];
  });
  if (named.length === 0) return { context: null, notes: [...notes, 'no_people'] };
  if (named.length > CONTEXT_MAX_PEOPLE) notes.push('people');

  const you = shorten(raw.you, CONTEXT_DETAIL_MAX_CHARS, () => notes.push('you')) || null;
  const parsed = chatgptContextSchema.safeParse({
    about,
    people: named.slice(0, CONTEXT_MAX_PEOPLE),
    you,
  });
  return { context: parsed.success ? parsed.data : null, notes };
}

/**
 * `text` trimmed and, if longer than `max`, cut at the last sentence end in
 * its second half, else at the last space, else at `max`. `cut` hears about it.
 */
export function shorten(
  text: string | null | undefined,
  max: number,
  cut: () => void = () => {}
): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= max) return trimmed;
  cut();
  const head = trimmed.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= max / 2) return head.slice(0, sentence + 1).trim();
  // A cut that lands just before a space is already at a word's end.
  if (/\s/.test(trimmed[max])) return head.trim();
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trim();
}
