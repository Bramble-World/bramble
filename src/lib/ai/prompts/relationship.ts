import type {
  CharacterContext,
  RelationshipContext,
  StorylineContext,
} from '@/lib/services/generation/generation.types';

/**
 * What a relationship to the reader means, for the prompts that list who is who.
 *
 * A bare label was not enough: "You and Mae (crush)" with nothing else drifted,
 * beat after beat, into the ex who still wants you back (player feedback,
 * 2026-11-21). So the relationships a player can pick on the naming screen carry
 * one line saying what they are, and what they are not. Anything else (an
 * import's "coworkers", a pool story's "your older sister") is rendered as its
 * label, which reads well enough on its own.
 */
const MEANINGS: Record<string, string> = {
  crush:
    'your crush: you have never been together, and your feelings are unspoken and unconfirmed; you do not know if they feel the same, and finding out is the story. Never write them as an ex, as wanting you back, or as if you had a past relationship or a breakup.',
  ex: 'your ex: you dated, and it ended.',
  old_friend: 'an old friend: you were close once, then drifted apart.',
  boss: 'your boss: you work for them.',
  sibling: 'your sibling: family.',
};

/** "Your crush", "crush", "my ex", "old friend" → the key in MEANINGS. */
function meaningKey(relationshipType: string): string {
  return relationshipType
    .trim()
    .toLowerCase()
    .replace(/^(your|my|an?)\s+/, '')
    .replace(/[\s-]+/g, '_');
}

export function relationshipMeaning(relationshipType: string): string | null {
  return MEANINGS[meaningKey(relationshipType)] ?? null;
}

/**
 * The line saying what someone is to the reader, e.g. "Mae is your crush: you
 * have never been together…". Only for a pair with the reader in it (the
 * meanings are written to "you"), and only for a type with a meaning; null
 * otherwise, and the caller keeps the label.
 */
export function relationshipToReader(
  storyline: Pick<StorylineContext, 'characters'>,
  relationship: Pick<RelationshipContext, 'characterAId' | 'characterBId' | 'relationshipType'>
): string | null {
  if (!relationship.relationshipType) return null;
  const meaning = relationshipMeaning(relationship.relationshipType);
  if (!meaning) return null;
  const byId = (id: string) => storyline.characters.find((c) => c.id === id);
  const a = byId(relationship.characterAId);
  const b = byId(relationship.characterBId);
  const other: CharacterContext | undefined = a?.isSelf ? b : b?.isSelf ? a : undefined;
  if (!other || other.isSelf) return null;
  return `${other.name} is ${meaning}`;
}
