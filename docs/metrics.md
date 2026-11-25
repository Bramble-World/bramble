# Metrics

Two sources, and the split is deliberate.

**PostHog** answers behavioural questions — funnels, retention, how often a thing
happens relative to another thing. Server events are sent from here as well as
from the Mac, because server events are _complete_: an ad blocker or a corporate
firewall can stop the client's, and nothing can stop these. Both ends identify
the person as `users.id` lowercased, so one human is one PostHog person.

**Admins are left out.** An account whose Clerk public metadata is
`{ "role": "admin" }` (`users.role = 'admin'`) produces no server events, the
same rule and the same check as the usage-data opt-out (`sendsUsageEvents` in
`src/lib/services/users/users.reader.ts`), and `GET /api/me`'s `isAdmin` tells
the iPhone to send none either. The team playing its own game would otherwise
blur every funnel. Events sent before someone was made an admin stay in PostHog.

**SQL against our own tables** answers anything about money or limits. Those
questions need to be exact, and PostHog is a sampled, best-effort pipeline we do
not own. Everything below runs against the database, needs no new tables, and is
true even for readers who have opted out of analytics — because none of it is
analytics, it is accounting. These queries count admins too; to leave the team
out, join `users u on u.id = s.user_id` and add `and u.role <> 'admin'`.

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

Each beat written is also the PostHog event `beat_played`, with `turn_order`,
`surfaces` (types only), `beyond_script`, `started_from_event`, `generation_ms`
(the model writing the beat), `wait_ms` (from the request reaching the server to
the beat being written, so the writing plus anything settled first),
`first_part_ms` (streamed beats only: until the headline or first text was sent)
and `origin`: where the story came from, `seed`, `reborn`, `reddit` or
`chatgpt` for a pool story, `none` for one never in the pool (a guest's opening,
a Mac import). Never which story. Breaking retention or beats per player down by
`origin` is what tells ChatGPT stories from pool ones. A resumed turn is not a
beat and fires nothing.

## Stories finished, and how long they ran

Every story ends somewhere around 16–24 beats (`storylines.target_beats`, 20 by
default). The PostHog event is `story_ended` with `turns` (how many beats
it took), `origin` (as below) and `phase`: `closing` when the model chose the moment, `must_end` when
the cap forced it. A high share of `must_end` means the model is not finding
endings on its own and the closing instructions need work. **The first story
is the exception**: it ends on beat 10 by design (`storylines.opening_id` is
set), so its `story_ended` is `turns: 10, phase: must_end` (later only for a first story already past 10 when this shipped) and says
nothing about the model. Leave it out when judging the closing instructions
(`where l.opening_id is null` below, joining `storylines l on l.id =
s.storyline_id`). From the database:

```sql
select date_trunc('day', s.ended_at)  as day,
       count(*)                       as stories_ended,
       round(avg(t.turn_order), 1)    as avg_beats
from storyline_sessions s
join story_turns t on t.session_id = s.id and t.is_ending
where s.ended_at >= now() - interval '30 days'
group by 1
order by 1 desc;
```

## The story pool

How answers become pool stories. Every row is one answer's story; the outcome
says what happened to it. A high share of `declined` or `low_quality` is the
writer doing its job (quality over quantity), not a fault.

```sql
select origin, status, reason, count(*), round(avg(quality_score), 1) as avg_score
from story_templates
group by 1, 2, 3
order by 1, 2, 4 desc;
```

The PostHog event `next_story_started` carries `origin` (`seed`, `reborn`) and
`how` (`countdown`, `begin_now`, or `later` from the notebook). The share of
`story_ended` followed by a `next_story_started` is how often players go on; the
share with `how = countdown` is the autoplay rate. The app sends
`next_story_stayed` and `countdown_paused` itself.

## Bramble in ChatGPT

`chatgpt_connected` (once per account, the first signed-in call to `/api/mcp`)
and `chatgpt_story_requested`, once per request, with `outcome` (`queued`,
`limited` past five a day, `flagged` by moderation and not kept, `not_written`
when a link had nothing to make a story from), `via` (`mcp` for
`write_my_story`, `link` for a link ChatGPT wrote, sent by the iPhone app) and
`stories` (how many were queued: at most 1 from `mcp`, up to 5 from a link).
Never what was sent. A story from ChatGPT that's started shows as
`next_story_started` with `origin: chatgpt`.

## Story reports

Players reporting a story (`POST .../report`). Each report also raises its own
Sentry warning (tag `flow:story_report`), which is the alert; the PostHog event
`story_reported` carries `reason` and `origin` (`seed`, `reborn`, or `none` for
a story not from the pool). The review queue is the table, read with
`review-reports list` (`docs/deployment.md`):

```sql
select status, reason, count(*) from story_reports group by 1, 2 order by 1, 3 desc;
```

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

## Guest onboarding (PostHog)

The iPhone's first-run funnel, from the server's side. A guest is identified by
their `users.id` from the first request, so no event needs re-attributing when
they sign up as a new account; a guest who joins an **existing** account is
aliased into it (`trackAlias`), so their beats follow them.

| Event               | Properties                                                                                                                                 | Fired when                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `onboarding_opened` | `opening_id`                                                                                                                               | `GET /api/v1/onboarding/opening` is served              |
| `person_named`      | `relationship`, `pronouns_given` (`yes`/`no`), `premise` (`wedding`, `moving_away`, `just_broke_up`, `saw_you_tonight`, `found_the_photo`) | the guest's story is written                            |
| `guest_beat_played` | `n` (1–3)                                                                                                                                  | beat 1 is written (scripted), and beats 2 and 3 (model) |
| `signup_completed`  | `merged`, `method` when the app sent one                                                                                                   | `POST /api/v1/guests/claim` succeeds                    |

`save_shown` and `save_not_now` are sent by the app, which is the only place
they happen. Live guests right now, from the database:

```sql
select count(*) from users where is_guest and guest_expires_at > now();
```

## Model calls, per stage (logs)

Every successful model call logs one line, `{"event":"generation", ...}`, with
`prompt`, `stage`, `model`, `effort`, `durationMs`, `inputTokens`,
`cachedInputTokens` (read from OpenAI's prompt cache, billed at a tenth),
`cacheWriteTokens` (written to it, billed at 1.25x), `outputTokens`,
`reasoningTokens` and `finishReason`. Numbers and names only, never the prompt or
the output. It is what tells the wait and the cost apart per stage: how long
consequences take against the beat, how much of a beat is thinking, and whether
the prompt cache is being hit. A settle after the response that fails logs
`consequences_later_failed` with the turn id.

**Why the cache stops where it does.** On gpt-6-astra (as on every model from
GPT-5.6) a request is read from the cache only up to a boundary: the end of the
system message or a block marked as a breakpoint, not any matching prefix. The
turn and consequence prompts mark theirs (`src/lib/ai/prompts/cache.ts`): after
the system message, after the consequence prompt's cast and relationships, and
inside the timeline at steps of four beats, behind the beats that still change
(the newest five, which carry "At stake", and on the consequence prompt anything
after the playhead). Everything after the last mark is new each beat and billed
at the plain rate. Their lines also carry `shape`, so consecutive beats of one
session can be compared:

```json
"shape": {
  "key": "3f9a01c2",
  "system": "a1b2c3d4:5321",
  "blocks": ["0c1d2e3f:812", "9a8b7c6d:20431", "11223344:4120", "55667788:9033"],
  "sections": ["head:…:120", "Recurring:…:300", "What has happened:…:24551", "Cast:…:2210"]
}
```

Each entry is `<first 8 hex of the SHA-256>:<characters>`, never the text. `key`
is the cache key (`turn:<session>` or `consequence:<session>`) hashed the same
way, to group one session's calls without its id. `blocks` are the stretches the
prompt is sent as, each but the last ending on a breakpoint; `sections` are its
`## ` sections in order (`head` is the part before the first, with the title).
Between two beats with the same `key`, the cached part should cover the blocks
whose hashes repeat; the first section whose hash changes is what broke the
prefix.

## What is deliberately not here

**Cost, stored.** The token counts are logged per call (above) but not kept
anywhere queryable, so a cost figure means reading the logs. Beats per day is
a proxy and a poor one, because a turn late in a long playthrough costs
considerably more than an early one — the consequence stage sends the whole
timeline. Persisting those counts is what would turn every query above into a
figure in pounds.
