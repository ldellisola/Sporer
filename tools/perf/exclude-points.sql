-- Removes points as the app's "Remove" does: `count` of them (default 1000), spread evenly over the history by time, in one batch.
--
--   docker exec -i sporer-perf-db psql -U postgres -d perf -X -v count=1000 < tools/perf/exclude-points.sql
--
-- For each of twice as many evenly spaced instants from the first point to the last it takes the first point at or after the instant (the
-- phone's silent gaps make some instants share one), and from the distinct points it keeps one in each of `count` equal runs of them, so
-- that there are exactly `count`, still spread over the whole history. The raw points stay in `locationlog`: the rows go to
-- `excluded_point`, which is what every read of points for processing leaves out. Run it before a backfill to time the backfill with
-- removals in the history (the anti-join of `PointStore` is then at work in every step), or before `explain-edits.sql` to see its plan.
\if :{?count}
\else
\set count 1000
\endif

with span as (
  select min(time) as first, max(time) as last from locationlog
), picks as (
  select distinct p.device, p.time
  from span
  cross join generate_series(0, 2 * :count - 1) as i
  cross join lateral (
    select l.device, l.time from locationlog l
    where l.time >= span.first + (span.last - span.first) * (i::float8 / (2 * :count))
    order by l.time limit 1
  ) as p
), ranked as (
  select device, time, row_number() over (order by time, device) as rn, count(*) over () as n from picks
), chosen as (
  select distinct on (floor((rn - 1)::float8 * :count / n)) device, time
  from ranked
  order by floor((rn - 1)::float8 * :count / n), time, device
), batch as materialized (
  select gen_random_uuid() as id
)
insert into excluded_point (device, time, batch_id)
select chosen.device, chosen.time, batch.id from chosen cross join batch
on conflict (device, time) do nothing;

select count(*) as excluded, count(distinct batch_id) as batches, min(time) as first, max(time) as last from excluded_point;
