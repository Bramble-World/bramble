# Metrics

Two sources, and the split is deliberate.

**PostHog** answers behavioural questions — funnels, retention, how often a thing
happens relative to another thing. Server events are sent from here as well as
from the Mac, because server events are _complete_: an ad blocker or a corporate
firewall can stop the client's, and nothing can stop these. Both ends identify
the person as `users.id` lowercased, so one human is one PostHog person.

**SQL against our own tables** answers anything about money or limits. Those
questions need to be exact, and PostHog is a sampled, best-effort pipeline we do
not own. Everything below runs against the database, needs no new tables, and is
true even for readers who have opted out of analytics — because none of it is
analytics, it is accounting.

Run with `doppler run -- psql "$DATABASE_URL"`.

## Beats generated per day

What the model is actually being asked to do. One row per turn written, so this
is the volume the energy allowance caps.

```sql
select date_trunc('day', t.created_at) as day,
       count(*)                        as beats,
       count(distinct s.user_id)       as readers,
       round(count(*)::numeric / nullif(count(distinct s.user_id), 0), 1) as beats_per_reader
from story_turns t
join storyline_sessions s on s.id = t.session_id
where t.created_at >= now() - interval '30 days'
group by 1
order by 1 desc;
```

`beats_per_reader` against the daily cap is the number that says whether the cap
is doing anything. If it sits far below 20, the limit is not the thing shaping
behaviour and tightening it would only annoy people.

## Readers who hit zero energy, per day

Who the limit is actually biting. A reader is counted on a day if they created
the full allowance within any rolling 24 hours that day — which is the same
window `energy.service.ts` uses, rather than a calendar day.

```sql
with spends as (
  select s.user_id,
         t.created_at,
         count(*) over (
           partition by s.user_id
           order by t.created_at
           range between interval '24 hours' preceding and current row
         ) as in_window
  from story_turns t
  join storyline_sessions s on s.id = t.session_id
  where t.created_at >= now() - interval '30 days'
)
select date_trunc('day', created_at) as day,
       count(distinct user_id)       as readers_at_the_cap
from spends
where in_window >= 20            -- keep in step with TURN_ENERGY_PER_DAY
group by 1
order by 1 desc;
```

The literal `20` is the one thing here that duplicates code. Change it with
`TURN_ENERGY_PER_DAY` or this quietly measures the wrong thing.

## Import success rate and median duration

```sql
select date_trunc('day', created_at) as day,
       count(*) filter (where status = 'ready')  as ready,
       count(*) filter (where status = 'failed') as failed,
       round(
         100.0 * count(*) filter (where status = 'ready')
         / nullif(count(*) filter (where status in ('ready', 'failed')), 0),
         1
       ) as success_rate_pct,
       percentile_cont(0.5) within group (
         order by extract(epoch from (updated_at - created_at))
       ) filter (where status = 'ready') as median_seconds
from imports
where created_at >= now() - interval '30 days'
group by 1
order by 1 desc;
```

Two caveats worth knowing before quoting the median. `updated_at` moves on every
stage change, so for a `ready` import it is the moment it finished — but for a
row that failed and was re-sent it is the _latest_ attempt, not the first. And
the duration is queue time plus run time, which is what a reader waits through
and therefore the honest number, but it is not a measure of how long extraction
takes.

### Why imports fail

```sql
select failure_code, count(*) as n
from imports
where status = 'failed' and created_at >= now() - interval '30 days'
group by 1
order by n desc;
```

`TRANSCRIPT_EXPIRED` dominating means jobs are not being picked up in time rather
than extraction being bad at its job — a queue problem wearing a generation
problem's clothes.

## What is deliberately not here

**Cost.** `GenerationMeta` carries `inputTokens` and `outputTokens` and every
call site discards them, so nothing records what anything cost. Beats per day is
a proxy and a poor one, because a turn late in a long playthrough costs
considerably more than an early one — the consequence stage sends the whole
timeline. Persisting those counts is what would turn every query above into a
figure in pounds.
