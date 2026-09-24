import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/utils/errors';
import { parseCsvTranscript } from './csv-transcript';

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
