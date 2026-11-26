import { describe, expect, it } from 'vitest';
import { castPartner, PARTNER, partnerIndex } from './premise';
import { DUET_PREMISES } from './seeds';
import { templateText } from '@/lib/pool/template';

describe('duet premises', () => {
  it('cast the other player exactly once on each side', () => {
    for (const [slug, premise] of Object.entries(DUET_PREMISES)) {
      expect({ slug, a: partnerIndex(premise.a) >= 0, b: partnerIndex(premise.b) >= 0 }).toEqual({
        slug,
        a: true,
        b: true,
      });
    }
  });

  // A first name may be up to 16 characters, and every limit must still hold.
  it('fit a story with the longest first name in place of the partner', () => {
    for (const premise of Object.values(DUET_PREMISES)) {
      for (const side of [premise.a, premise.b]) {
        const cast = castPartner(side, 'Maximilianaaaaaa');
        expect(templateText(cast)).not.toContain(PARTNER);
        expect(cast.cast[partnerIndex(side)].name).toBe('Maximilianaaaaaa');
      }
    }
  });

  it('give both sides the same title, so the two players know it is one story', () => {
    for (const premise of Object.values(DUET_PREMISES))
      expect(premise.a.title).toBe(premise.b.title);
  });
});
