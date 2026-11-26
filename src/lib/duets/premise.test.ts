import { describe, expect, it } from 'vitest';
import { castPartner, PARTNER, partnerIndex, premiseProblem, withPartnerAsThey } from './premise';
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

describe('the rules a written premise must keep', () => {
  const seed = Object.values(DUET_PREMISES)[0];
  const withPartner = (change: object) => ({
    ...seed,
    a: {
      ...seed.a,
      cast: seed.a.cast.map((member, i) =>
        i === partnerIndex(seed.a) ? { ...member, ...change } : member
      ),
    },
  });

  it('passes every seed', () => {
    for (const premise of Object.values(DUET_PREMISES)) expect(premiseProblem(premise)).toBeNull();
  });

  // The two players could be any two friends: never a couple.
  it.each(['your ex', 'your crush', 'your girlfriend', 'someone you are dating', 'your partner'])(
    'refuses a partner who is %s',
    (relationshipType) => {
      expect(premiseProblem(withPartner({ relationshipType }))).toBe('romance');
    }
  );

  it('keeps friends, siblings and roommates', () => {
    for (const relationshipType of [
      'your best friend',
      'your older sister',
      'your roommate',
      'your lab partner',
    ])
      expect(premiseProblem(withPartner({ relationshipType }))).toBeNull();
  });

  it('makes the other player they, whatever was written', () => {
    const premise = withPartnerAsThey(withPartner({ pronouns: 'she' }));
    expect(premise.a.cast[partnerIndex(premise.a)].pronouns).toBe('they');
  });
});
