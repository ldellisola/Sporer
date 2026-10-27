-- The plans of every query the trips endpoints run, with their real timings and buffers (EXPLAIN (ANALYZE, BUFFERS)).
--
--   docker exec -i sporer-perf-db psql -U postgres -d perf -X -v trip=2026-03-04 < tools/perf/explain-trips.sql
--
-- `trip` is the id of a trip (the date of its first night, as GET /api/trips lists them). The queries are copied from TripStore
-- (ListAsync, LoadHomesAsync, FindAsync) with PlaceStore.Survivors spelled out, and the parameters as psql variables; change one
-- there and change it here. The values are literals, so the plans are the custom plans the first executions of a statement get.
-- The nights, home periods and trips are those the worker stored after the backfill; the segments and places are the timeline's.
-- A sibling of explain.sql, which holds the queries of the day, range, heat, place and status endpoints.
set time zone 'UTC';
\timing off
\pset pager off

-- The trip's span and its nights, as FindAsync works them out (an ongoing trip's span runs to the end of the latest segment).
select start_utc::text as span_start,
       greatest(start_utc, coalesce(end_utc, (select end_utc from segment order by start_utc desc limit 1)))::text as span_end,
       least(id, local_start_date - 1)::text as nights_from, greatest(last_night, local_end_date)::text as nights_to
from trip where id = :'trip'::date
\gset

\echo '=== Trips list: the trips (TripStore.ListAsync) ==='
explain (analyze, buffers)
select to_char(id, 'YYYY-MM-DD') as FirstNight, to_char(last_night, 'YYYY-MM-DD') as LastNight, nights as Nights,
       start_utc as StartUtc, end_utc as EndUtc, start_tz as StartZone, end_tz as EndZone,
       to_char(local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(local_end_date, 'YYYY-MM-DD') as LocalEndDate
from trip order by id desc;

\echo '=== Trips list: the nights of every trip (TripStore.ListAsync) ==='
explain (analyze, buffers)
with recursive
named as (
    select t.id as trip_id, n.date, n.place_id, n.latitude, n.longitude
    from trip t
    join night n on n.date between t.id and t.last_night
    where n.latitude is not null and n.longitude is not null
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
select to_char(named.trip_id, 'YYYY-MM-DD') as TripId, to_char(named.date, 'YYYY-MM-DD') as Date,
       p.city as City, p.country as Country, named.latitude as Latitude, named.longitude as Longitude
from named
left join survivor on survivor.origin = named.place_id
left join place p on p.id = survivor.id
order by named.trip_id, named.date;

\echo '=== Trips list and day view: the home periods (TripStore.LoadHomesAsync) ==='
explain (analyze, buffers)
with recursive
named as (
    select place_id from home_period
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
select to_char(h.from_date, 'YYYY-MM-DD') as FromDate, to_char(h.to_date, 'YYYY-MM-DD') as ToDate,
       p.id as PlaceId, p.latitude as Latitude, p.longitude as Longitude
from home_period h
join survivor on survivor.origin = h.place_id
join place p on p.id = survivor.id
order by (h.source = 'user') desc, h.from_date desc, h.id desc;

\echo '=== Trip: the trip (TripStore.FindAsync) ==='
explain (analyze, buffers)
select to_char(id, 'YYYY-MM-DD') as FirstNight, to_char(last_night, 'YYYY-MM-DD') as LastNight, nights as Nights,
       start_utc as StartUtc, end_utc as EndUtc, start_tz as StartZone, end_tz as EndZone,
       to_char(local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(local_end_date, 'YYYY-MM-DD') as LocalEndDate
from trip where id = :'trip'::date;

\echo '=== Trip: the latest segment, for an ongoing trip (TripStore.FindAsync) ==='
explain (analyze, buffers)
select end_utc from segment order by start_utc desc limit 1;

\echo '=== Trip: its nights and the ones around them (TripStore.FindAsync) ==='
explain (analyze, buffers)
with recursive
named as (
    select place_id from night where date between :'nights_from'::date and :'nights_to'::date and place_id is not null
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
select to_char(n.date, 'YYYY-MM-DD') as Date, p.id as PlaceId, p.city as City, p.country as Country,
       n.latitude as Latitude, n.longitude as Longitude
from night n
left join survivor on survivor.origin = n.place_id
left join place p on p.id = survivor.id
where n.date between :'nights_from'::date and :'nights_to'::date
order by n.date;

\echo '=== Trip: its stays and moves (TripStore.FindAsync) ==='
explain (analyze, buffers)
with recursive
spanned as (
    select id, kind, start_utc, end_utc, local_start_date, local_end_date, place_id, mode, distance_m,
           case when kind = 'move' then geometry_coarse::text end as geometry
    from segment
    where kind in ('stay', 'move') and start_utc < :'span_end'::timestamptz and end_utc > :'span_start'::timestamptz
      and start_utc >= coalesce((select max(start_utc) from segment where start_utc <= :'span_start'::timestamptz), :'span_start'::timestamptz)
),
named as (
    select place_id from spanned where place_id is not null
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
select s.id as Id, s.kind as Kind, s.start_utc as StartUtc, s.end_utc as EndUtc,
       to_char(s.local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(s.local_end_date, 'YYYY-MM-DD') as LocalEndDate,
       p.id as PlaceId, coalesce(p.user_name, p.osm_name) as PlaceName, p.city as City, p.country as Country,
       s.mode as Mode, s.distance_m as DistanceM, s.geometry as GeometryCoarseJson
from spanned s
left join survivor on survivor.origin = s.place_id
left join place p on p.id = survivor.id
order by s.start_utc, s.id;
