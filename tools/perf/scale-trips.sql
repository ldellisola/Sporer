-- What-if on a COPY of the history (never the database of the measurements): a history with about 100 trips instead of 3, to see what the
-- trips list costs when it is long. Make the copy, add the trips, and ask an API that has the worker off (Processing__Enabled=false: the
-- worker would work the trips out again from the nights and put the three back) over the copy:
--
--   docker exec sporer-perf-db psql -U postgres -c "create database perf_scale template perf strategy file_copy"
--   docker exec -i sporer-perf-db psql -U postgres -d perf_scale -X < tools/perf/scale-trips.sql
--
-- The trips: 4 nights every 8 days from 2024-07-01, skipping any that touches one of the real three. The nights are the ones the history
-- has (the person is at home on them: the list does not look at where they are, it draws what it is given).
insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
select d, d + 3, 4,
       (d + time '07:00') at time zone 'Europe/Oslo', (d + 4 + time '17:00') at time zone 'Europe/Oslo',
       'Europe/Oslo', 'Europe/Oslo', d, d + 4
from (select date '2024-07-01' + 8 * k as d from generate_series(0, 120) as k) as days
where d <= date '2026-08-31'
  and not exists (select 1 from trip t where t.id <= d + 3 and t.last_night >= d)
  and exists (select 1 from night n where n.date = d and n.latitude is not null);
select count(*) as trips from trip;
