-- The plans of every query the read endpoints run, with their real timings and buffers (EXPLAIN (ANALYZE, BUFFERS)).
--
--   docker exec -i sporer-perf-db psql -U postgres -d perf -X \
--     -v day=2025-09-10 -v from=2025-01-01 -v to=2025-12-31 -v place=1 < tools/perf/explain.sql
--
-- The queries are copied from the stores (SegmentStore, RangeStore, PlaceStore, ProcessingQueue), with the parameters as psql
-- variables; change one there and change it here. The values are literals, so the plans are the custom plans the first
-- executions of a statement get. Run against the synthetic history (tools/Sporer.SyntheticData) after its backfill and an ANALYZE
-- of the timeline tables (autovacuum does it).
set time zone 'UTC';
\timing off
\pset pager off

\echo '=== Day: the day`s segments (SegmentStore.FindDayAsync) ==='
explain (analyze, buffers)
select s.id as Id, s.kind as Kind, s.start_utc as StartUtc, s.end_utc as EndUtc, s.start_tz as StartTz, s.end_tz as EndTz,
       s.mode as Mode, s.distance_m as DistanceM, s.geometry_detail::text as GeometryDetailJson,
       p.id as PlaceId, coalesce(p.user_name, p.osm_name) as PlaceName, p.city as PlaceCity,
       p.country as PlaceCountry, p.latitude as PlaceLatitude, p.longitude as PlaceLongitude
from segment s
left join lateral (
    with recursive chain as (
        select id, merged_into_id, user_name, osm_name, city, country, latitude, longitude, 0 as depth
        from place where id = s.place_id
        union all
        select next.id, next.merged_into_id, next.user_name, next.osm_name, next.city, next.country,
               next.latitude, next.longitude, chain.depth + 1
        from chain join place next on next.id = chain.merged_into_id
        where chain.depth < 32
    )
    select * from chain where merged_into_id is null
) p on true
where s.local_start_date <= :'day'::date and s.local_end_date >= :'day'::date
order by s.start_utc, s.id;

\echo '=== Day: the zone before a day with no segment (SegmentStore.FindZoneBeforeAsync) ==='
explain (analyze, buffers)
select end_tz from segment where kind = 'stay' and local_end_date < :'day'::date order by start_utc desc limit 1;

\echo '=== Day and range: waiting work (ProcessingQueue.HasPendingWorkAsync) ==='
explain (analyze, buffers)
select exists (select 1 from dirty_range where from_utc < (:'to'::date::timestamp + interval '38 hours')::timestamptz
                                            and to_utc >= (:'from'::date::timestamp - interval '14 hours')::timestamptz)
    or exists (select 1 from processing_state
               where id = 1 and backfill_cursor < backfill_to
                 and backfill_cursor < (:'to'::date::timestamp + interval '38 hours')::timestamptz);

\echo '=== Range: the moves (RangeStore.FindAsync) ==='
explain (analyze, buffers)
select id as Id, mode as Mode, start_utc as StartUtc, end_utc as EndUtc, distance_m as DistanceM,
       geometry_coarse::text as GeometryCoarseJson
from segment
where kind = 'move' and local_start_date <= :'to'::date and local_end_date >= :'from'::date
order by start_utc, id;

\echo '=== Range: the places (RangeStore.FindAsync) ==='
explain (analyze, buffers)
with recursive
stays as (
    select place_id, start_utc, end_utc, start_tz, local_start_date
    from segment
    where kind = 'stay' and place_id is not null and local_start_date <= :'to'::date and local_end_date >= :'from'::date
),
chain as (
    select p.id as origin, p.id, p.merged_into_id, 0 as depth
    from place p
    where p.id in (select place_id from stays)
    union all
    select chain.origin, next.id, next.merged_into_id, chain.depth + 1
    from chain join place next on next.id = chain.merged_into_id
    where chain.depth < 32
),
survivor as (
    select origin, id from chain where merged_into_id is null
),
clipped as (
    select sv.id as place_id,
           extract(epoch from least(st.end_utc, (:'to'::date + 1)::timestamp at time zone st.start_tz)
                            - greatest(st.start_utc, :'from'::date::timestamp at time zone st.start_tz)) as seconds
    from stays st
    join survivor sv on sv.origin = st.place_id
)
select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.city as City, p.country as Country,
       p.latitude as Latitude, p.longitude as Longitude,
       sum(c.seconds)::double precision as Seconds, count(*) as Visits
from clipped c
join place p on p.id = c.place_id
where c.seconds > 0
group by p.id;

\echo '=== Range: the days (RangeStore.FindAsync) ==='
explain (analyze, buffers)
with recursive
stays as (
    select place_id, start_utc, end_utc, start_tz, local_start_date
    from segment
    where kind = 'stay' and place_id is not null and local_start_date <= :'to'::date and local_end_date >= :'from'::date
),
chain as (
    select p.id as origin, p.id, p.merged_into_id, 0 as depth
    from place p
    where p.id in (select place_id from stays)
    union all
    select chain.origin, next.id, next.merged_into_id, chain.depth + 1
    from chain join place next on next.id = chain.merged_into_id
    where chain.depth < 32
),
survivor as (
    select origin, id from chain where merged_into_id is null
),
day_places as (
    select st.local_start_date as local_date, count(distinct sv.id) as places
    from stays st
    join survivor sv on sv.origin = st.place_id
    group by st.local_start_date
),
day_moves as (
    select local_start_date as local_date,
           coalesce(sum(distance_m) filter (where kind = 'move'), 0)::double precision as distance_m,
           coalesce(sum(extract(epoch from end_utc - start_utc)) filter (where kind = 'move'), 0)::double precision as moving_seconds
    from segment
    where local_start_date between :'from'::date and :'to'::date
    group by local_start_date
)
select to_char(m.local_date, 'YYYY-MM-DD') as Date, m.distance_m as DistanceM, m.moving_seconds as MovingSeconds,
       coalesce(p.places, 0) as Places
from day_moves m
left join day_places p on p.local_date = m.local_date
order by m.local_date;

\echo '=== Heat (RangeStore.FindHeatAsync) ==='
explain (analyze, buffers)
with clipped as (
    select round(latitude::numeric, 3) as lat, round(longitude::numeric, 3) as lon,
           extract(epoch from least(end_utc, (:'to'::date + 1)::timestamp at time zone start_tz)
                            - greatest(start_utc, :'from'::date::timestamp at time zone start_tz)) as secs
    from segment
    where kind = 'stay' and local_start_date <= :'to'::date and local_end_date >= :'from'::date
      and latitude between -90 and 90 and longitude between -180 and 180
)
select lat::double precision as Latitude, lon::double precision as Longitude, sum(secs)::double precision as Seconds
from clipped
where secs > 0
group by lat, lon;

\echo '=== Place: the totals (PlaceStore.FindDetailAsync) ==='
explain (analyze, buffers)
with recursive
resolved as (
    select id, merged_into_id, 0 as depth
    from place
    where id = :'place'::bigint
    union all
    select next.id, next.merged_into_id, resolved.depth + 1
    from resolved join place next on next.id = resolved.merged_into_id
    where resolved.depth < 32
),
root as (
    select id from resolved where merged_into_id is null
),
members as (
    select id, 0 as depth from root
    union all
    select merged.id, members.depth + 1
    from members join place merged on merged.merged_into_id = members.id
    where members.depth < 32
),
survivor as (
    select id
    from root
    where exists (select 1 from segment s where s.place_id in (select id from members))
)
select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.address as Address, p.city as City, p.country as Country,
       p.latitude as Latitude, p.longitude as Longitude,
       totals.seconds as TotalSeconds, totals.visits as Visits, totals.first_visit as FirstVisit, totals.last_visit as LastVisit
from place p
cross join lateral (
    select coalesce(sum(extract(epoch from s.end_utc - s.start_utc)), 0)::double precision as seconds,
           count(*) as visits, min(s.start_utc) as first_visit, max(s.start_utc) as last_visit
    from segment s
    where s.kind = 'stay' and s.place_id in (select id from members)
) totals
where p.id = (select id from survivor);

\echo '=== Place: the latest visits (PlaceStore.FindDetailAsync) ==='
explain (analyze, buffers)
with recursive
resolved as (
    select id, merged_into_id, 0 as depth
    from place
    where id = :'place'::bigint
    union all
    select next.id, next.merged_into_id, resolved.depth + 1
    from resolved join place next on next.id = resolved.merged_into_id
    where resolved.depth < 32
),
root as (
    select id from resolved where merged_into_id is null
),
members as (
    select id, 0 as depth from root
    union all
    select merged.id, members.depth + 1
    from members join place merged on merged.merged_into_id = members.id
    where members.depth < 32
),
survivor as (
    select id
    from root
    where exists (select 1 from segment s where s.place_id in (select id from members))
)
select s.start_utc as StartUtc, s.end_utc as EndUtc, to_char(s.local_start_date, 'YYYY-MM-DD') as Date, s.start_tz as TimeZone
from segment s
where s.kind = 'stay' and s.place_id in (select id from members)
order by s.start_utc desc, s.id desc
limit 50;

\echo '=== Status: the processing state (ProcessingQueue.GetStateAsync) ==='
explain (analyze, buffers)
select algorithm_version as AlgorithmVersion, backfill_from as BackfillFrom, backfill_to as BackfillTo,
       backfill_cursor as BackfillCursor, paused as Paused, last_run_at as LastRunAt, last_error as LastError,
       backfill_chunk_attempts as BackfillChunkAttempts
from processing_state where id = 1;

\echo '=== Status: the backlog (ProcessingQueue.GetBacklogAsync) ==='
explain (analyze, buffers) select count(*) from dirty_range;
explain (analyze, buffers)
select from_utc as FromUtc, to_utc as ToUtc, attempts as Attempts, last_error as LastError
from dirty_range where attempts > 0 order by from_utc, id;

\echo '=== Status: the places in use (PlaceStore.CountInUseAsync) ==='
explain (analyze, buffers)
select count(*) as Total,
       count(*) filter (where p.geocode_state = 'pending') as Unnamed,
       count(*) filter (where p.geocode_state = 'failed') as Failed
from place p
where p.merged_into_id is null and exists (select 1 from segment s where s.place_id = p.id);
