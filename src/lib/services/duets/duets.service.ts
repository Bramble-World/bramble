import { eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '@/index';
import { characters, duets, persons, storyTemplates, storylines } from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { loadPremise, premiseSlugs } from './premises.store';
import { castPartner, partnerIndex } from '@/lib/duets/premise';
import { storyTemplateSchema, type StoryTemplate } from '@/lib/pool/template';
import { NotFoundError } from '@/lib/utils/errors';
import type { Executor } from '../executor';
import { attachHeldCrossings, forgetCrossingsFrom } from './crossings.service';

/**
 * A story for two (`duets`): made when an invite is accepted, one side per
 * player, each written as a `duet` template for that player and offered as
 * their next story before anything else. Starting it copies it into their own
 * rows, as any next story is (`startNextStory`), and `linkDuetSide` records
 * which storyline and which character is whose.
 *
 * What crosses between the two sides is PR 3's: this only makes the pair.
 */

export type DuetPlayer = { userId: string; name: string };

/**
 * The premise this pair gets: the one played least, among those these two
 * haven't had together; any, least-played, once they've had them all.
 */
export async function pickPremise(tx: Executor, a: string, b: string): Promise<string> {
  const slugs = await premiseSlugs(tx);
  const rows = await tx
    .select({
      premise: duets.premise,
      played: sql<number>`count(*)::int`,
      together: sql<number>`count(*) filter (where
        (${duets.sideAUserId} = ${a} and ${duets.sideBUserId} = ${b}) or
        (${duets.sideAUserId} = ${b} and ${duets.sideBUserId} = ${a}))::int`,
    })
    .from(duets)
    .where(inArray(duets.premise, slugs))
    .groupBy(duets.premise);
  const stats = new Map(rows.map((r) => [r.premise, r]));
  const unseen = slugs.filter((slug) => !stats.get(slug)?.together);
  const pool = unseen.length ? unseen : slugs;
  const fewest = Math.min(...pool.map((slug) => stats.get(slug)?.played ?? 0));
  const candidates = pool.filter((slug) => (stats.get(slug)?.played ?? 0) === fewest);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Makes the pair: a `duets` row and a ready `duet` template for each player,
 * with the other cast by the first name they gave. Side A is the inviter's.
 */
export async function createDuet(
  tx: Executor,
  premiseSlug: string,
  sideA: DuetPlayer,
  sideB: DuetPlayer
): Promise<string> {
  const premise = await loadPremise(tx, premiseSlug);
  if (!premise) throw new NotFoundError('Duet premise', premiseSlug);

  const [duet] = await tx
    .insert(duets)
    .values({
      premise: premiseSlug,
      sideAUserId: sideA.userId,
      sideBUserId: sideB.userId,
      sideAName: sideA.name,
      sideBName: sideB.name,
      sideAPartnerIndex: partnerIndex(premise.a),
      sideBPartnerIndex: partnerIndex(premise.b),
    })
    .returning({ id: duets.id });

  const write = async (player: DuetPlayer, content: StoryTemplate) => {
    const [row] = await tx
      .insert(storyTemplates)
      .values({ origin: 'duet', userId: player.userId, status: 'ready', content, duetId: duet.id })
      .returning({ id: storyTemplates.id });
    return row.id;
  };
  const sideATemplateId = await write(sideA, castPartner(premise.a, sideB.name));
  const sideBTemplateId = await write(sideB, castPartner(premise.b, sideA.name));

  await tx.update(duets).set({ sideATemplateId, sideBTemplateId }).where(eq(duets.id, duet.id));
  return duet.id;
}

/**
 * The other player's first name, for a `duet` template's next-story card.
 * Null when it isn't one, or the other player has left.
 */
export async function partnerNameFor(templateId: string): Promise<string | null> {
  const [row] = await db
    .select({ a: duets.sideATemplateId, aName: duets.sideAName, bName: duets.sideBName })
    .from(duets)
    .innerJoin(storyTemplates, eq(storyTemplates.duetId, duets.id))
    .where(eq(storyTemplates.id, templateId))
    .limit(1);
  if (!row) return null;
  return row.a === templateId ? row.bName : row.aName;
}

/**
 * Records that a player started their side: its storyline, and the character
 * in it who is the other player (by where the premise cast them).
 */
export async function linkDuetSide(
  tx: Executor,
  userId: string,
  templateId: string,
  storylineId: string,
  castCharacterIds: string[]
): Promise<void> {
  const [duet] = await tx
    .select()
    .from(duets)
    .innerJoin(storyTemplates, eq(storyTemplates.duetId, duets.id))
    .where(eq(storyTemplates.id, templateId))
    .limit(1);
  if (!duet) return;
  const side = duet.duets.sideATemplateId === templateId ? 'a' : 'b';
  const partnerCharacterId =
    castCharacterIds[side === 'a' ? duet.duets.sideAPartnerIndex : duet.duets.sideBPartnerIndex];

  await tx.update(storylines).set({ duetId: duet.duets.id }).where(eq(storylines.id, storylineId));
  await tx
    .update(duets)
    .set(
      side === 'a'
        ? { sideAStorylineId: storylineId, sideAPartnerCharacterId: partnerCharacterId }
        : { sideBStorylineId: storylineId, sideBPartnerCharacterId: partnerCharacterId }
    )
    .where(eq(duets.id, duet.duets.id));
  // What crossed while this side waited: its first beat opens with the newest.
  await attachHeldCrossings(tx, duet.duets.id, userId, storylineId);
  await track(userId, { name: 'duet_started', properties: { side } });
}

/** First names a departed partner's character takes: plain, and none of the premises'. */
const NEUTRAL_NAMES = ['Sky', 'Rowan', 'Jules', 'Remy', 'Avery', 'Quinn', 'Ellis', 'Marlow'];

export function neutralNameFor(avoid: readonly string[]): string {
  const taken = new Set(avoid.map((name) => name.toLowerCase()));
  return NEUTRAL_NAMES.find((name) => !taken.has(name.toLowerCase())) ?? 'Sam';
}

/** `name` as a whole word, for a Postgres regex: escaped, between word boundaries. */
function wordPattern(name: string): string {
  return `\\m${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`;
}

/**
 * Before a player's account goes: on every story for two they were in, the
 * other side carries on, and their character there is renamed to a neutral
 * first name, everywhere it was written: the person, the character, the
 * events, the background, every beat and choice, and the template if that
 * side hasn't started. The row keeps only the neutral name for them. Their own
 * side goes with their account; what crossed from them stays as story text,
 * with nothing that links it to them.
 */
export async function forgetDuetPartner(tx: Executor, userId: string): Promise<void> {
  const rows = await tx
    .select()
    .from(duets)
    .where(or(eq(duets.sideAUserId, userId), eq(duets.sideBUserId, userId)));

  for (const duet of rows) {
    const leaving = duet.sideAUserId === userId ? 'a' : 'b';
    const leavingName = leaving === 'a' ? duet.sideAName : duet.sideBName;
    const stayingName = leaving === 'a' ? duet.sideBName : duet.sideAName;
    const otherTemplateId = leaving === 'a' ? duet.sideBTemplateId : duet.sideATemplateId;
    const otherStorylineId = leaving === 'a' ? duet.sideBStorylineId : duet.sideAStorylineId;
    const otherPartnerId =
      leaving === 'a' ? duet.sideBPartnerCharacterId : duet.sideAPartnerCharacterId;

    const premise = await loadPremise(tx, duet.premise);
    const premiseNames = premise
      ? [...premise.a.cast, ...premise.b.cast].map((member) => member.name)
      : [];
    const neutral = neutralNameFor([stayingName, ...premiseNames]);

    if (otherTemplateId) await renameInTemplate(tx, otherTemplateId, leavingName, neutral);
    if (otherStorylineId) {
      await renameInStoryline(tx, otherStorylineId, otherPartnerId, leavingName, neutral);
    }

    // Nothing waits on the other side that came from them; what already
    // reached it is story text there, renamed above.
    await forgetCrossingsFrom(tx, duet.id, leaving);

    await tx
      .update(duets)
      .set(leaving === 'a' ? { sideAName: neutral } : { sideBName: neutral })
      .where(eq(duets.id, duet.id));
  }
}

async function renameInTemplate(tx: Executor, templateId: string, from: string, to: string) {
  const [row] = await tx
    .select({ content: storyTemplates.content })
    .from(storyTemplates)
    .where(eq(storyTemplates.id, templateId));
  if (!row?.content) return;
  const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(pattern, to);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fill(v)]));
    }
    return value;
  };
  await tx
    .update(storyTemplates)
    .set({ content: storyTemplateSchema.parse(fill(row.content)) })
    .where(eq(storyTemplates.id, templateId));
}

async function renameInStoryline(
  tx: Executor,
  storylineId: string,
  partnerCharacterId: string | null,
  from: string,
  to: string
) {
  const re = wordPattern(from);
  const swap = (column: string) =>
    sql`${sql.identifier(column)} = regexp_replace(${sql.identifier(column)}, ${re}, ${to}, 'g')`;

  if (partnerCharacterId) {
    const [character] = await tx
      .select({ personId: characters.personId })
      .from(characters)
      .where(eq(characters.id, partnerCharacterId));
    if (character) {
      await tx.update(persons).set({ name: to }).where(eq(persons.id, character.personId));
    }
  }

  const id = sql`${storylineId}::uuid`;
  await tx.execute(
    sql`update storylines set ${swap('title')}, ${swap('setting')}, ${swap('arc_summary')} where id = ${id}`
  );
  await tx.execute(
    sql`update characters set ${swap('description')}, ${swap('want')}, ${swap('avoids')} where storyline_id = ${id}`
  );
  await tx.execute(
    sql`update events set ${swap('title')}, ${swap('description')}, ${swap('stakes')} where storyline_id = ${id}`
  );
  await tx.execute(sql`update context_entries set ${swap('content')} where storyline_id = ${id}`);
  await tx.execute(sql`
    update story_turns set ${swap('headline')}, ${swap('narrative_content')}
    where session_id in (select id from storyline_sessions where storyline_id = ${id})`);
  await tx.execute(sql`
    update turn_choices set ${swap('label')}, ${swap('description')}, ${swap('reply')}
    where turn_id in (select t.id from story_turns t join storyline_sessions s on s.id = t.session_id
                      where s.storyline_id = ${id})`);
  await tx.execute(sql`
    update turn_surfaces set payload = regexp_replace(payload::text, ${re}, ${to}, 'g')::jsonb
    where turn_id in (select t.id from story_turns t join storyline_sessions s on s.id = t.session_id
                      where s.storyline_id = ${id})`);
  await tx.execute(sql`
    update storyline_sessions set ending = regexp_replace(ending::text, ${re}, ${to}, 'g')::jsonb
    where storyline_id = ${id} and ending is not null`);
}
