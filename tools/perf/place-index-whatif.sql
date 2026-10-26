-- What an index on segment.place_id would buy, on a copy of the timeline in temporary tables (nothing of the database is touched:
-- the copies live in this session and shadow `segment` and `place`).
--
--   docker exec -i sporer-perf-db psql -U postgres -d perf -X -v copies=12 -v place=1 < tools/perf/place-index-whatif.sql
--
-- The timeline is copied `copies` times over (12 times the 7,607 segments of the synthetic history is 91,284), as if the history
-- were twelve times as long, then the queries that look a place up by id (the place view and the status page) are timed as they
-- are, and again with the index a migration would add. Compare the "Execution Time" lines.
set time zone 'UTC';
\pset pager off

create temp table place as select * from public.place;
alter table place add primary key (id);
create temp table segment (like public.segment including defaults);
insert into segment
select s.id + k * 1000000, s.kind, s.start_utc + k * interval '1 microsecond', s.end_utc + k * interval '1 microsecond',
       s.start_tz, s.end_tz, s.local_start_date, s.local_end_date, s.place_id, s.latitude, s.longitude, s.mode, s.distance_m,
       s.geometry_detail, s.geometry_coarse, s.point_count
from public.segment s cross join generate_series(0, :copies - 1) as k;
alter table segment add primary key (id);
create index ix_segment_start on segment (start_utc);
create index ix_segment_local_dates on segment (local_start_date, local_end_date);
create index ix_segment_stays on segment (start_utc) where kind = 'stay';
analyze segment;
analyze place;
select count(*) as segments_in_the_copy from segment;

\echo '##### Without an index on place_id #####'
\echo '--- Place: the totals (PlaceStore.FindDetailAsync) ---'
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

\echo '--- Place: the latest visits (PlaceStore.FindDetailAsync) ---'
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

\echo '--- Status: the places in use (PlaceStore.CountInUseAsync) ---'
explain (analyze, buffers)
select count(*) as Total,
       count(*) filter (where p.geocode_state = 'pending') as Unnamed,
       count(*) filter (where p.geocode_state = 'failed') as Failed
from place p
where p.merged_into_id is null and exists (select 1 from segment s where s.place_id = p.id);

create index ix_segment_place on segment (place_id, start_utc desc);
analyze segment;

\echo '##### With ix_segment_place (place_id, start_utc desc) #####'
\echo '--- Place: the totals (PlaceStore.FindDetailAsync) ---'
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

\echo '--- Place: the latest visits (PlaceStore.FindDetailAsync) ---'
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

\echo '--- Status: the places in use (PlaceStore.CountInUseAsync) ---'
explain (analyze, buffers)
select count(*) as Total,
       count(*) filter (where p.geocode_state = 'pending') as Unnamed,
       count(*) filter (where p.geocode_state = 'failed') as Failed
from place p
where p.merged_into_id is null and exists (select 1 from segment s where s.place_id = p.id);
