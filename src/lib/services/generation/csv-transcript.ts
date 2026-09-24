import { ValidationError } from '@/lib/utils/errors';
import type { TranscriptMessage } from '@/lib/ai/prompts/extraction.prompt';
import type { Transcript } from './extraction.service';

/**
 * Reads a message export into a transcript.
 *
 * Deliberately tolerant about column names, because there is no standard: Apple's
 * own export, imessage-exporter, iMazing and the various scripts people use all
 * disagree on what to call the text, the direction and the timestamp. Rather than
 * requiring one shape and failing on the rest, the header is matched against a
 * list of known aliases and the file says which columns it found.
 *
 * Nothing here is persisted. The parsed messages are an argument to extraction,
 * which writes only the model's retelling — invariants.md §1. The file is never
 * written to disk either: it arrives as an upload, is parsed in memory, and is
 * gone when the request ends.
 */

/**
 * Aliases per field, **in order of preference**, lowercased and
 * punctuation-stripped.
 *
 * The order is the whole point. These are matched alias-first — the earliest
 * alias that appears anywhere in the header wins — rather than header-first,
 * which takes whichever plausible column happens to sit leftmost.
 *
 * That distinction is not academic. A real export headed
 * `date,chat,sender,direction,message` carries both `sender` and `direction`,
 * and header-first order picks `sender`: a person's name, matching nothing in
 * FROM_ME, so every message in the file reads as incoming. The extraction then
 * describes a conversation the account holder never spoke in, and looks entirely
 * plausible while being wrong about every line.
 *
 * `sender` stays last, for exports that really do use it to mean direction, but
 * anything explicit beats it.
 */
const COLUMNS = {
  text: ['message', 'text', 'body', 'messagetext', 'content'],
  direction: ['direction', 'isfromme', 'fromme', 'ismine', 'issent', 'type', 'sender'],
  sentAt: ['date', 'timestamp', 'datetime', 'sentat', 'readabledate', 'messagedate', 'time'],
  handle: [
    'chat',
    'chatname',
    'handle',
    'handleid',
    'contact',
    'phonenumber',
    'phone',
    'address',
    'with',
  ],
} as const;

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Values that mean "I sent this", across the exporters that use text rather than 0/1. */
const FROM_ME = new Set(['1', 'true', 'yes', 'me', 'sent', 'outgoing', 'fromme', 'self', 'mine']);

export type CsvTranscriptResult = {
  transcript: Transcript;
  /** Which header each field was taken from, so a misdetection is visible. */
  mapping: Record<keyof typeof COLUMNS, string | null>;
  totalRows: number;
  skipped: number;
};

export function parseCsvTranscript(raw: string, surface = 'imessage'): CsvTranscriptResult {
  const rows = parseCsv(raw);
  if (rows.length < 2) {
    throw new ValidationError('That CSV has no rows beyond a header.');
  }

  const header = rows[0].map(normalise);
  // Alias-first, not header-first: the most specific name wins wherever a file
  // offers several plausible columns. See COLUMNS above.
  const indexOf = (aliases: readonly string[]) => {
    for (const alias of aliases) {
      const found = header.indexOf(alias);
      if (found !== -1) return found;
    }
    return null;
  };

  const columns = {
    text: indexOf(COLUMNS.text),
    direction: indexOf(COLUMNS.direction),
    sentAt: indexOf(COLUMNS.sentAt),
    handle: indexOf(COLUMNS.handle),
  };

  if (columns.text === null) {
    throw new ValidationError(
      `No message column found. Looked for: ${COLUMNS.text.join(', ')}. Header was: ${rows[0].join(', ')}`
    );
  }

  const messages: TranscriptMessage[] = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const text = row[columns.text]?.trim();
    // Attachments, reactions and empty rows carry no text and would otherwise
    // become blank lines the model has to guess at.
    if (!text) {
      skipped += 1;
      continue;
    }

    const directionValue = columns.direction === null ? '' : (row[columns.direction] ?? '');
    messages.push({
      // Normalised the same way as the headers, so "From Me" and "fromme" agree.
      isFromMe: FROM_ME.has(normalise(directionValue)),
      handle: (columns.handle === null ? '' : (row[columns.handle] ?? '')).trim() || 'them',
      text,
      sentAt: (columns.sentAt === null ? '' : (row[columns.sentAt] ?? '')).trim(),
    });
  }

  if (messages.length === 0) {
    throw new ValidationError('That CSV parsed, but every row was empty of message text.');
  }

  return {
    transcript: { surface, messages },
    mapping: {
      text: columns.text === null ? null : rows[0][columns.text],
      direction: columns.direction === null ? null : rows[0][columns.direction],
      sentAt: columns.sentAt === null ? null : rows[0][columns.sentAt],
      handle: columns.handle === null ? null : rows[0][columns.handle],
    },
    totalRows: rows.length - 1,
    skipped,
  };
}

/**
 * A minimal RFC 4180 reader: quoted fields, escaped quotes, embedded newlines.
 *
 * Hand-written rather than adding a dependency, because message text is exactly
 * the content that contains commas, quotes and line breaks — a naive split on
 * commas would silently shred it, and this is a harness, not a parser worth
 * taking a package for.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Only end the row on a real break, and swallow CRLF as one.
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** A conversation pulled out of an export, ready to become one storyline. */
export type Thread = {
  /** The chat identifier the export used. Shown to the user, never stored raw. */
  handle: string;
  messages: TranscriptMessage[];
  /** Total characters of message text, which is what the per-call cap measures. */
  chars: number;
  /** True when older messages were dropped to fit. Worth surfacing. */
  truncated: boolean;
};

export type SplitOptions = {
  /** Threads shorter than this are dropped: an export is mostly automated noise. */
  minMessages: number;
  /** Per-thread character ceiling; the newest messages are kept. */
  maxChars: number;
};

/**
 * Splits an export into the conversations worth telling a story about.
 *
 * A storyline comes from a conversation, so the thread is the natural unit —
 * one call over an entire export would produce a single incoherent story
 * spanning years and everyone in it, quite apart from exceeding any context
 * window.
 *
 * Two filters, both earning their place on real data. A 45,000-message export
 * held 440 threads with a median length of two: overwhelmingly delivery
 * notifications and verification codes, which cost money and produce nothing.
 * And its largest single thread ran to 654k characters, past what one call
 * carries on its own.
 *
 * Oversized threads keep their **most recent** messages rather than their first.
 * A recent slice of a long-running conversation is a coherent story; the opening
 * of one is where the least has happened yet.
 */
export function splitIntoThreads(
  transcript: Transcript,
  { minMessages, maxChars }: SplitOptions
): Thread[] {
  const byHandle = new Map<string, TranscriptMessage[]>();
  for (const message of transcript.messages) {
    const existing = byHandle.get(message.handle);
    if (existing) existing.push(message);
    else byHandle.set(message.handle, [message]);
  }

  const threads: Thread[] = [];

  for (const [handle, all] of byHandle) {
    if (all.length < minMessages) continue;

    // Walk backwards so the newest messages are the ones that survive the cap.
    const kept: TranscriptMessage[] = [];
    let chars = 0;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const length = all[i].text.length;
      if (chars + length > maxChars) break;
      kept.push(all[i]);
      chars += length;
    }
    kept.reverse();

    // Everything dropped can happen when a single message exceeds the cap.
    if (kept.length === 0) continue;

    threads.push({ handle, messages: kept, chars, truncated: kept.length < all.length });
  }

  // Busiest first: the most substantial conversations are the ones worth having
  // extracted if a run is stopped part way.
  return threads.sort((a, b) => b.messages.length - a.messages.length);
}
