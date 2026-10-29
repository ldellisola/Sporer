-- The plans of the queries Plan 4's editing added or changed, with their real timings and buffers (EXPLAIN (ANALYZE, BUFFERS)): the
-- anti-join that leaves removed points out of every read of raw points, the day's points that edit mode draws, and the place search.
--
--   docker exec -i sporer-perf-db psql -U postgres -d perf -X -v from='2025-10-20 00:00:00+00' -v day_from='2025-10-22 00:00:00+00' \
--     -v day_to='2025-10-23 00:00:00+00' < tools/perf/explain-edits.sql
--
-- `from` starts a week (a backfill step is seven days, `Processing__BackfillChunkDays`); `day_from` and `day_to` are the span of a day's
-- points (a local day's, as `DayZone.FindPointSpanAsync` gives it; the heaviest day's, to see the worst). The queries are copied from
-- PointStore (NotExcluded, LoadAsync, NearestAsync, LoadPositionsAsync) and PlaceStore (SearchAsync, with its InUse, Survivors and
-- VisitedPlaces spelled out), with the parameters as literals, so the plans are the custom plans a statement gets on its first executions.
-- Run it on a history after its backfill, with `exclude-points.sql` run before it for the removals to be there.
\if :{?from}
\else
\set from '2025-10-20 00:00:00+00'
\endif
\if :{?day_from}
\else
\set day_from '2025-10-22 00:00:00+00'
\endif
\if :{?day_to}
\else
\set day_to '2025-10-23 00:00:00+00'
\endif
set time zone 'UTC';
\timing off
\pset pager off

\echo '=== The removals in the week, and in all ==='
select (select count(*) from excluded_point) as excluded_in_all,
       (select count(*) from excluded_point where time >= :'from'::timestamptz and time <= :'from'::timestamptz + interval '7 days') as excluded_in_the_week,
       (select count(*) from locationlog where time >= :'from'::timestamptz and time <= :'from'::timestamptz + interval '7 days') as points_in_the_week;

\echo '=== A step of seven days, as the segmenter loads it: with the anti-join (PointStore.LoadAsync) ==='
explain (analyze, buffers)
select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, l.speed as Speed,
       l.horizontal_accuracy as HorizontalAccuracy, l.motion as Motion
from locationlog l
where l.time >= :'from'::timestamptz and l.time <= :'from'::timestamptz + interval '7 days'
  and not exists (select 1 from excluded_point e where e.device = l.device and e.time = l.time)
order by l.time, l.device;

\echo '=== The same step without it (what LoadAsync read before the removals), for comparison ==='
explain (analyze, buffers)
select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, l.speed as Speed,
       l.horizontal_accuracy as HorizontalAccuracy, l.motion as Motion
from locationlog l
where l.time >= :'from'::timestamptz and l.time <= :'from'::timestamptz + interval '7 days'
order by l.time, l.device;

\echo '=== The point after the step, which the segmenter needs (PointStore.LoadAsync, includeNextPoint) ==='
explain (analyze, buffers)
select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, l.speed as Speed,
       l.horizontal_accuracy as HorizontalAccuracy, l.motion as Motion
from locationlog l
where l.time > :'from'::timestamptz + interval '7 days'
  and not exists (select 1 from excluded_point e where e.device = l.device and e.time = l.time)
order by l.time, l.device limit 1;

\echo '=== The nearest point of a night: the latest at or before the instant (PointStore.NearestAsync) ==='
explain (analyze, buffers)
select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, l.speed as Speed,
       l.horizontal_accuracy as HorizontalAccuracy, l.motion as Motion
from locationlog l
where l.time <= :'from'::timestamptz + interval '3 days' and l.time >= :'from'::timestamptz + interval '3 days' - interval '12 hours'
  and not exists (select 1 from excluded_point e where e.device = l.device and e.time = l.time)
order by l.time desc, l.device limit 1;

\echo '=== The points of a day, for edit mode (PointStore.LoadPositionsAsync) ==='
explain (analyze, buffers)
select l.time as Time, l.device as Device, l.longitude as Longitude, l.latitude as Latitude from locationlog l
where l.time >= :'day_from'::timestamptz and l.time < :'day_to'::timestamptz
  and not exists (select 1 from excluded_point e where e.device = l.device and e.time = l.time)
order by l.time, l.device;

\echo '=== The place search with no query (PlaceStore.SearchAsync) ==='
explain (analyze, buffers)
with recursive
stays as (
    select place_id, count(*) as visits
    from segment
    where kind = 'stay' and place_id is not null
    group by place_id
),
named as (
    select place_id from stays
),
chain as (
    select p.id as origin, p.id, p.merged_into_id, 0 as depth
    from place p
    where p.id in (select place_id from named)
    union all
    select chain.origin, next.id, next.merged_into_id, chain.depth + 1
    from chain join place next on next.id = chain.merged_into_id
    where chain.depth < 32
),
survivor as (
    select origin, id from chain where merged_into_id is null
)
select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.address as Address, sum(stays.visits)::bigint as Visits
from stays
join survivor on survivor.origin = stays.place_id
join place p on p.id = survivor.id
where p.merged_into_id is null and p.id in (
        with recursive up as (
            select s.place_id as id, 0 as depth
            from segment s
            where s.place_id is not null
            group by s.place_id
            union all
            select link.merged_into_id, up.depth + 1
            from up join place link on link.id = up.id
            where link.merged_into_id is not null and up.depth < 32
        )
        select id from up)
  and (null::text is null
       or strpos(lower(coalesce(p.user_name, p.osm_name, '')), lower(null::text)) > 0
       or strpos(lower(coalesce(p.address, '')), lower(null::text)) > 0)
group by p.id
order by Visits desc, p.id
limit 20;

\echo '=== The place search with a query of three letters (PlaceStore.SearchAsync) ==='
explain (analyze, buffers)
with recursive
stays as (
    select place_id, count(*) as visits
    from segment
    where kind = 'stay' and place_id is not null
    group by place_id
),
named as (
    select place_id from stays
),
chain as (
    select p.id as origin, p.id, p.merged_into_id, 0 as depth
    from place p
    where p.id in (select place_id from named)
    union all
    select chain.origin, next.id, next.merged_into_id, chain.depth + 1
    from chain join place next on next.id = chain.merged_into_id
    where chain.depth < 32
),
survivor as (
    select origin, id from chain where merged_into_id is null
)
select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.address as Address, sum(stays.visits)::bigint as Visits
from stays
join survivor on survivor.origin = stays.place_id
join place p on p.id = survivor.id
where p.merged_into_id is null and p.id in (
        with recursive up as (
            select s.place_id as id, 0 as depth
            from segment s
            where s.place_id is not null
            group by s.place_id
            union all
            select link.merged_into_id, up.depth + 1
            from up join place link on link.id = up.id
            where link.merged_into_id is not null and up.depth < 32
        )
        select id from up)
  and ('pla'::text is null
       or strpos(lower(coalesce(p.user_name, p.osm_name, '')), lower('pla'::text)) > 0
       or strpos(lower(coalesce(p.address, '')), lower('pla'::text)) > 0)
group by p.id
order by Visits desc, p.id
limit 20;
