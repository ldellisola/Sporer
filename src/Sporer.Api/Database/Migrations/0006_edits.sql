-- Editing (plan 4). The owner's own data lives in new tables: locationLog and the tables of 0003 and 0005 are not touched, except that the
-- derived table trip (rebuilt from the nights on every refresh) gets two nullable columns. A rebuild of the timeline never touches the
-- new tables: what the owner decided is not derived from anything.

-- A point the owner removed from the timeline. The raw point stays in locationLog; every read of points for processing leaves it out.
-- (device, time) is how a point is told from another. batch_id is the removal it was part of, so that one request can be undone.
create table if not exists excluded_point (
    device text not null, time timestamptz not null, batch_id uuid not null,
    excluded_at timestamptz not null default now(), primary key (device, time));
create index if not exists ix_excluded_point_batch on excluded_point (batch_id);

-- What the owner changed of a detected trip: its name, its first and last local dates, or that it is gone. The row is found by the
-- trip's first night as the detector had it when the edit was made (detected_id), so it keeps to that trip across rebuilds.
create table if not exists trip_edit (
    detected_id date primary key,                 -- the detected trip's first night when the edit was made
    detected_last_night date not null,
    name text null, start_date date null, end_date date null,  -- local dates; null = as detected
    deleted boolean not null default false, deleted_label text null,
    updated_at timestamptz not null default now());

-- The owner's settings, one row each: key and JSON value.
create table if not exists app_setting (key text primary key, value jsonb not null, updated_at timestamptz not null default now());

-- What a stored trip is called and which detected trip it was before it was edited. Both are written with the trip, which is derived.
alter table trip add column if not exists name text null;           -- the owner's name, null = automatic
alter table trip add column if not exists detected_id date null;    -- the detected first night when the trip was edited
