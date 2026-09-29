import { sql } from 'drizzle-orm';
import { db } from '@/index';
import { personRelationships, persons } from '@/db/schema/tables';

/**
 * The aggregates behind the world map.
 *
 * Computed in SQL rather than by loading rows and folding them in JS. This is
 * the one read that touches every event a user owns, on every cold start of the
 * client, so that is not a stylistic preference.
 *
 * Every query is anchored on a `userId` predicate, which is what makes the
 * service safe without per-id ownership checks: no identifier in these results
 * ever arrived in a request, so there is nothing to confuse with another
 * tenant's.
 */

export type PersonRow = {
  personId: string;
  name: string;
  isSelf: boolean;
  relationshipType: string | null;
};

export type ExplorationRow = {
  personId: string;
  unexploredBeats: number;
  storylineCount: number;
  met: boolean;
  lastActivityAt: Date | null;
};

/**
 * The reader's people, each with their relationship to the reader if recorded.
 *
 * The pair columns are stored sorted (`CHECK (person_a_id < person_b_id)`), so
 * the reader can be on either side and both have to be checked.
 */
export async function peopleFor(userId: string): Promise<PersonRow[]> {
  const rows = await db.execute(sql`
    with me as (
      select id from ${persons}
      where ${persons.userId} = ${userId} and ${persons.isSelf} = true
      limit 1
    )
    select
      p.id                      as "personId",
      p.name                    as "name",
      p.is_self                 as "isSelf",
      (
        select pr.relationship_type
        from ${personRelationships} pr, me
        where pr.user_id = ${userId}
          and (
            (pr.person_a_id = p.id and pr.person_b_id = me.id) or
            (pr.person_b_id = p.id and pr.person_a_id = me.id)
          )
        limit 1
      )                         as "relationshipType"
    from ${persons} p
    where p.user_id = ${userId}
  `);

  return rows.rows as unknown as PersonRow[];
}

/**
 * Per person: how much story is left, how many arcs, whether they have been met,
 * and when their stories were last touched.
 *
 * `origin = 'extracted'` is the same predicate `scriptExhausted` uses to decide
 * whether script remains. Counting generated beats would mean playing a story
 * makes its node grow — the opposite of what "bigger = more to explore" says.
 *
 * "Reached" is the furthest playhead across the reader's sessions on a storyline,
 * or 0 when they have never played it, in which case every beat is unexplored.
 *
 * "Met" mirrors `metCharacterIds`: appearing in a beat at or below that reached
 * order. The reader themselves is handled by the caller, since being present at
 * your own story is not a fact about beats.
 */
export async function explorationFor(userId: string): Promise<ExplorationRow[]> {
  const rows = await db.execute(sql`
    with reached as (
      select storyline_id, max(playhead_order) as reached
      from storyline_sessions
      where user_id = ${userId}
      group by storyline_id
    ),
    cast_rows as (
      select c.person_id, c.id as character_id, c.storyline_id,
             coalesce(r.reached, 0) as reached
      from characters c
      join storylines s on s.id = c.storyline_id and s.user_id = ${userId}
      left join reached r on r.storyline_id = c.storyline_id
    )
    select
      cr.person_id as "personId",
      count(distinct cr.storyline_id)::int as "storylineCount",
      coalesce(sum(
        (select count(*) from events e
          where e.storyline_id = cr.storyline_id
            and e.origin = 'extracted'
            and e.narrative_order > cr.reached)
      ), 0)::int as "unexploredBeats",
      bool_or(exists(
        select 1 from event_participants ep
        join events e2 on e2.id = ep.event_id
        where ep.character_id = cr.character_id
          and e2.narrative_order <= cr.reached
      )) as "met",
      (select max(ses.last_active_at) from storyline_sessions ses
        where ses.user_id = ${userId}
          and ses.storyline_id in (
            select storyline_id from cast_rows x where x.person_id = cr.person_id
          )) as "lastActivityAt"
    from cast_rows cr
    group by cr.person_id
  `);

  return (rows.rows as unknown as ExplorationRow[]).map((r) => ({
    ...r,
    lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null,
  }));
}

/**
 * Structural edges between the reader's people, with how much story they share.
 *
 * `sharedStorylines` counts the storylines both are cast in. It is what gives an
 * edge a thickness worth drawing — the relationship type alone is a label, and
 * a map where every line is the same weight says nothing about which of these
 * people actually appear together.
 *
 * Counted in SQL rather than by folding cast rows in JS, like everything else
 * here: this read runs on every cold start of the client.
 */
export async function edgesFor(userId: string): Promise<
  Array<{
    aPersonId: string;
    bPersonId: string;
    relationshipType: string | null;
    sharedStorylines: number;
  }>
> {
  const rows = await db.execute(sql`
    select
      pr.person_a_id as "aPersonId",
      pr.person_b_id as "bPersonId",
      pr.relationship_type as "relationshipType",
      (
        select count(distinct ca.storyline_id)::int
        from characters ca
        join characters cb
          on cb.storyline_id = ca.storyline_id
         and cb.person_id = pr.person_b_id
        join storylines s
          on s.id = ca.storyline_id and s.user_id = ${userId}
        where ca.person_id = pr.person_a_id
      ) as "sharedStorylines"
    from ${personRelationships} pr
    where pr.user_id = ${userId}
  `);

  return rows.rows as unknown as Array<{
    aPersonId: string;
    bPersonId: string;
    relationshipType: string | null;
    sharedStorylines: number;
  }>;
}
