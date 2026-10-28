-- Home and trips (spec 6.6). Everything here is derived from the timeline and rebuilt from it, so these are new tables only:
-- locationLog and the tables of 0003 are not touched.

-- Where the person slept, one row per night. A night is identified by the date of its evening and is read at 03:00 local time
-- on the next day (instant_utc, in zone). source says how it was located: the stay covering that instant, else the nearest raw
-- point, else it is unknown and has no position. place_id is the place of the stay (as the stay has it, merged or not) or the
-- place a point matched.
create table if not exists night (
    date date primary key, instant_utc timestamptz not null, zone text not null,
    source text not null check (source in ('stay','point','none')),
    place_id bigint null references place(id), latitude double precision null, longitude double precision null);

-- The periods during which a place was home, both ends inclusive night dates (to_date null = still home). 'detected' ones are
-- rebuilt on every refresh; 'user' ones are the owner's and are never rewritten by it.
create table if not exists home_period (
    id bigserial primary key, place_id bigint not null references place(id),
    from_date date not null, to_date date null, source text not null check (source in ('detected','user')));
create index if not exists ix_home_period_dates on home_period (from_date);

-- The trips, rebuilt as a whole from the nights. The id is the date of the first away night, so it is the same after every
-- rebuild as long as the trip starts the same night. end_utc null = ongoing.
create table if not exists trip (
    id date primary key, last_night date not null, nights int not null,
    start_utc timestamptz not null, end_utc timestamptz null, start_tz text not null, end_tz text not null,
    local_start_date date not null, local_end_date date not null);

-- The window of time whose nights, homes and trips are out of date, as the union of what was reprocessed since the last
-- refresh (null = nothing pending). Kept here so that a restart does not lose it.
create table if not exists night_refresh (
    id int primary key check (id = 1), from_utc timestamptz null, to_utc timestamptz null);
insert into night_refresh (id) values (1) on conflict do nothing;
