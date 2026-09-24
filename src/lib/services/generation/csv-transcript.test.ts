import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/utils/errors';
import { parseCsvTranscript, splitIntoThreads } from './csv-transcript';

/**
 * There is no standard shape for a message export, so the parser is tolerant and
 * these pin what it tolerates.
 *
 * The failure that matters is silent: a misdetected direction column makes every
 * message look like it came from the same person, and the extraction reads
 * perfectly well while being wrong about who said what.
 */
describe('parseCsvTranscript', () => {
  it('reads the common Apple-style export', () => {
    const { transcript, mapping } = parseCsvTranscript(
      [
        'date,is_from_me,text,handle',
        '2026-03-02 19:04,0,"you said it in front of everyone",+15550104477',
        '2026-03-02 19:41,1,"I know. I was tired.",+15550104477',
      ].join('\n')
    );

    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0].isFromMe).toBe(false);
    expect(transcript.messages[1].isFromMe).toBe(true);
    expect(mapping.direction).toBe('is_from_me');
  });

  /**
   * A real export's header, which contains BOTH `sender` and `direction`.
   *
   * Matching headers in file order picks `sender` — a person's name — which
   * matches nothing in the from-me set, so every message in the file reads as
   * incoming and the extraction describes a conversation the user never spoke
   * in. It looks entirely plausible while being wrong about every line, which is
   * why this is pinned rather than left to the alias list staying lucky.
   */
  it('prefers an explicit direction column over an ambiguous sender column', () => {
    const { transcript, mapping } = parseCsvTranscript(
      [
        'date,chat,sender,direction,message,attachment,attachment_type,message_id',
        '2026-03-02 19:04,Maya,Maya,received,"you said it in front of everyone",,,1',
        '2026-03-02 19:41,Maya,Great,sent,"I know. I was tired.",,,2',
      ].join('\n')
    );

    expect(mapping.direction).toBe('direction');
    expect(mapping.text).toBe('message');
    expect(mapping.handle).toBe('chat');
    expect(transcript.messages[0].isFromMe).toBe(false);
    expect(transcript.messages[1].isFromMe).toBe(true);
  });

  it('reads sent/received as a direction', () => {
    const { transcript } = parseCsvTranscript(
      ['direction,message', 'sent,hello', 'received,hi back'].join('\n')
    );
    expect(transcript.messages.map((m) => m.isFromMe)).toStrictEqual([true, false]);
  });

  // A BOM is normal in exports written on macOS and would otherwise make the
  // first column name unmatchable.
  it('ignores a byte order mark on the first header', () => {
    const { mapping } = parseCsvTranscript('\ufeffdate,direction,message\n2026,sent,hello');
    expect(mapping.sentAt).toBe('\ufeffdate');
    expect(mapping.text).toBe('message');
  });

  // Quoted fields containing commas, quotes and newlines are exactly what
  // message text looks like — a naive comma split shreds it silently.
  it('survives commas, escaped quotes and newlines inside a message', () => {
    const { transcript } = parseCsvTranscript(
      [
        'text,is_from_me',
        '"well, that is one way to put it",0',
        '"she said ""fine"" and left",0',
        '"line one\nline two",1',
      ].join('\n')
    );

    expect(transcript.messages[0].text).toBe('well, that is one way to put it');
    expect(transcript.messages[1].text).toBe('she said "fine" and left');
    expect(transcript.messages[2].text).toBe('line one\nline two');
  });

  it.each([
    ['Message,Sender,Date', 'Message'],
    ['body,direction,timestamp', 'body'],
    ['Message Text,Is From Me,Readable Date', 'Message Text'],
  ])('finds the text column in header "%s"', (header, expected) => {
    const { mapping } = parseCsvTranscript([header, 'hello,1,2026-01-01'].join('\n'));
    expect(mapping.text).toBe(expected);
  });

  it.each([
    ['1', true],
    ['true', true],
    ['Yes', true],
    ['Me', true],
    ['sent', true],
    ['0', false],
    ['false', false],
    ['them', false],
    ['', false],
  ])('reads direction value %s as fromMe=%s', (value, expected) => {
    const { transcript } = parseCsvTranscript(['text,is_from_me', `hello,${value}`].join('\n'));
    expect(transcript.messages[0].isFromMe).toBe(expected);
  });

  // Attachments and reactions export as rows with no text. Keeping them would
  // hand the model blank lines to interpret.
  it('skips rows with no message text and reports how many', () => {
    const { transcript, totalRows, skipped } = parseCsvTranscript(
      ['text,is_from_me', 'hello,1', ',0', '   ,1', 'goodbye,0'].join('\n')
    );

    expect(transcript.messages).toHaveLength(2);
    expect(totalRows).toBe(4);
    expect(skipped).toBe(2);
  });

  it('works when there is no direction or handle column at all', () => {
    const { transcript, mapping } = parseCsvTranscript(['text', 'hello', 'goodbye'].join('\n'));

    expect(transcript.messages).toHaveLength(2);
    expect(mapping.direction).toBeNull();
    // Everything reads as incoming, which is wrong but visible — the reported
    // mapping shows no direction column was found.
    expect(transcript.messages.every((m) => !m.isFromMe)).toBe(true);
    expect(transcript.messages[0].handle).toBe('them');
  });

  it('names the headers it saw when it cannot find the text', () => {
    expect(() => parseCsvTranscript(['id,when,who', '1,2026,me'].join('\n'))).toThrow(
      ValidationError
    );
    expect(() => parseCsvTranscript(['id,when,who', '1,2026,me'].join('\n'))).toThrow(
      /id, when, who/
    );
  });

  it('rejects a file with nothing but a header', () => {
    expect(() => parseCsvTranscript('text,is_from_me')).toThrow(ValidationError);
  });

  it('handles CRLF line endings', () => {
    const { transcript } = parseCsvTranscript('text,is_from_me\r\nhello,1\r\ngoodbye,0\r\n');
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0].text).toBe('hello');
  });
});

describe('splitIntoThreads', () => {
  const build = (spec: Array<[handle: string, count: number, size?: number]>) => ({
    surface: 'imessage',
    messages: spec.flatMap(([handle, count, size = 10]) =>
      Array.from({ length: count }, (_, i) => ({
        isFromMe: i % 2 === 0,
        handle,
        text: `${i}`.padEnd(size, 'x'),
        sentAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      }))
    ),
  });

  it('keeps conversations long enough to be a story and drops the rest', () => {
    const threads = splitIntoThreads(
      build([
        ['maya', 60],
        ['delivery', 2],
        ['bank', 1],
      ]),
      {
        minMessages: 50,
        maxChars: 400_000,
      }
    );

    expect(threads.map((t) => t.handle)).toStrictEqual(['maya']);
  });

  it('orders by size, so a stopped run has done the biggest first', () => {
    const threads = splitIntoThreads(
      build([
        ['small', 51],
        ['big', 200],
        ['mid', 80],
      ]),
      {
        minMessages: 50,
        maxChars: 400_000,
      }
    );

    expect(threads.map((t) => t.handle)).toStrictEqual(['big', 'mid', 'small']);
  });

  // The opening of a long conversation is where the least has happened. A recent
  // slice is a story; the first 400k characters of a three-year thread is not.
  it('keeps the newest messages when a thread is too large', () => {
    const [thread] = splitIntoThreads(build([['maya', 100, 100]]), {
      minMessages: 10,
      maxChars: 1_000,
    });

    expect(thread.truncated).toBe(true);
    expect(thread.chars).toBeLessThanOrEqual(1_000);
    // The last message of the original survives; the first does not.
    expect(thread.messages.at(-1)!.text).toBe('99'.padEnd(100, 'x'));
    expect(thread.messages.some((m) => m.text === '0'.padEnd(100, 'x'))).toBe(false);
  });

  it('marks a thread untruncated when it fits whole', () => {
    const [thread] = splitIntoThreads(build([['maya', 60]]), {
      minMessages: 50,
      maxChars: 400_000,
    });

    expect(thread.truncated).toBe(false);
    expect(thread.messages).toHaveLength(60);
  });

  it('drops a thread whose every message is larger than the cap', () => {
    const threads = splitIntoThreads(build([['maya', 60, 500]]), {
      minMessages: 50,
      maxChars: 100,
    });

    expect(threads).toStrictEqual([]);
  });
});
