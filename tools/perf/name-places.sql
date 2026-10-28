-- Names the places of the synthetic history the way Nominatim would have, by where they are, so that the trips have the names, cities and
-- day lines a real history has. The API of the performance checks runs with Nominatim__Enabled=false, which leaves every place without a
-- name, a city or a country: a trip is then called "Trip", its cities are empty and its days say "Travelling". Run it once on the database
-- of the history after the backfill (it touches only `place`):
--
--   docker exec -i sporer-perf-db psql -U postgres -d perf -X < tools/perf/name-places.sql
--
-- Oslo, Tromso, Lisbon and Tokyo are the places the generator's person lives in and visits (tools/Sporer.SyntheticData). Three in four
-- places get an OSM name ("Place 12"); the rest stay unnamed, as many places of a real history do.
update place set
  city = case
    when latitude between 59.0 and 60.5 and longitude between 10.0 and 11.5 then 'Oslo'
    when latitude between 69.0 and 70.5 and longitude between 18.0 and 20.0 then 'Tromsø'
    when latitude between 38.0 and 39.5 and longitude between -10.0 and -8.0 then 'Lisbon'
    when latitude between 35.0 and 36.5 and longitude between 139.0 and 140.5 then 'Tokyo'
  end,
  country = case
    when latitude between 59.0 and 60.5 and longitude between 10.0 and 11.5 then 'Norway'
    when latitude between 69.0 and 70.5 and longitude between 18.0 and 20.0 then 'Norway'
    when latitude between 38.0 and 39.5 and longitude between -10.0 and -8.0 then 'Portugal'
    when latitude between 35.0 and 36.5 and longitude between 139.0 and 140.5 then 'Japan'
  end,
  osm_name = case when id % 4 <> 0 then 'Place ' || id end,
  address = 'Street ' || id,
  geocode_state = 'done';
select city, country, count(*) as places, count(osm_name) as named from place group by 1, 2 order by 3 desc;
