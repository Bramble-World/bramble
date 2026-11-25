import { describe, expect, it } from 'vitest';
import { idResolver, shortId } from './short-ids';

const maya = '3f9a2b1c-0000-4000-8000-000000000001';
const jordan = 'a1b2c3d4-0000-4000-8000-000000000002';

describe('short ids', () => {
  it('is the first six hex digits, lowercase', () => {
    expect(shortId(maya)).toBe('3f9a2b');
    expect(shortId('ABCDEF12-0000-4000-8000-000000000000')).toBe('abcdef');
  });

  it('reads a handle back as its id, however the model wrapped it', () => {
    const read = idResolver([maya, jordan]);
    expect(read('3f9a2b')).toBe(maya);
    expect(read(' [A1B2C3] ')).toBe(jordan);
  });

  // Output from before short handles, and the test fakes, carry the real id.
  it('still reads a full id', () => {
    expect(idResolver([maya])(maya)).toBe(maya);
  });

  it('resolves nothing it was not given, and nothing ambiguous', () => {
    const twin = '3f9a2bff-0000-4000-8000-000000000003';
    const read = idResolver([maya, twin, jordan]);
    expect(read('3f9a2b')).toBeUndefined();
    expect(read('ffffff')).toBeUndefined();
    expect(read(null)).toBeUndefined();
    expect(read('')).toBeUndefined();
    expect(read(jordan.slice(0, 6))).toBe(jordan);
  });
});
