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

/** Aliases seen across the common exporters, lowercased and punctuation-stripped. */
const COLUMNS = {
  text: ['text', 'body', 'message', 'messagetext', 'content'],
  direction: ['isfromme', 'fromme', 'sender', 'direction', 'type', 'ismine', 'sent'],
  sentAt: ['date', 'timestamp', 'datetime', 'time', 'sentat', 'readabledate', 'messagedate'],
  handle: [
    'handle',
    'handleid',
    'contact',
    'phone',
    'phonenumber',
    'address',
    'chat',
    'chatname',
    'with',
  ],
} as const;

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Values that mean "I sent this", across the exporters that use text rather than 0/1. */
const FROM_ME = new Set(['1', 'true', 'yes', 'me', 'sent', 'outgoing', 'from me', 'self']);

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
  const indexOf = (aliases: readonly string[]) => {
    const found = header.findIndex((column) => aliases.includes(column));
    return found === -1 ? null : found;
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
      isFromMe: FROM_ME.has(directionValue.trim().toLowerCase()),
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
