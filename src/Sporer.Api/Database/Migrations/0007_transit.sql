-- Trains and buses (transit spec). locationLog is not touched, and neither is any table of 0005 and 0006. Of 0003's tables, segment (derived,
-- and rebuilt from the raw points on every rebuild) gets a new check of its mode and a column that says the owner set it; that is the first
-- change this makes to a check of 0003. processing_state gets three columns, for the stretches that wait to be rebuilt for the tiles that have
-- arrived. The owner's own choices and the lines fetched from OpenStreetMap live in two new tables, which a rebuild never touches.

-- The six modes a move can have. 0003 left the check without a name of its own, so Postgres called it segment_mode_check; it is dropped and
-- added again under that name, which leaves it the same however often this runs.
alter table segment drop constraint if exists segment_mode_check;
alter table segment add constraint segment_mode_check check (mode in ('walk','cycle','drive','bus','train','flight'));

-- Whether the mode of a move is the owner's: a mode_edit covers more than half of its time. Written with the segment.
alter table segment add column if not exists mode_edited boolean not null default false;

-- The modes the owner set, by time span, as removed points and trip edits are kept: a move whose time an edit covers more than half of has
-- the edit's mode (the edit that covers most of it, when there are several), however often the timeline is rebuilt.
create table if not exists mode_edit (
    id bigserial primary key,
    from_utc timestamptz not null, to_utc timestamptz not null,
    mode text not null constraint mode_edit_mode_check check (mode in ('walk','cycle','drive','bus','train','flight')),
    created_at timestamptz not null default now(),
    constraint mode_edit_span_check check (to_utc >= from_utc));
create index if not exists ix_mode_edit_from on mode_edit (from_utc);

-- The railway and bus-route lines of OpenStreetMap, fetched from Overpass in the background, one row per kind and tile of 0.1 by 0.1 degrees
-- (lat_index = floor(latitude * 10), lon_index = floor(longitude * 10)), kept for good. state: pending (waiting to be fetched), done (lines
-- holds them, as int32 microdegrees, see TransitLineBlob; a tile with no line is done and holds none) or failed (set aside after 5 failed
-- fetches, and tried again once a day). waiting_from and waiting_to span the moves that asked for the tile: that stretch is rebuilt when it
-- arrives. next_attempt_at null is due now.
create table if not exists transit_tile (
    kind text not null check (kind in ('rail','bus')),
    lat_index int not null check (lat_index between -900 and 899),
    lon_index int not null check (lon_index between -1800 and 1799),
    state text not null default 'pending' check (state in ('pending','done','failed')),
    lines bytea null, line_count int not null default 0,
    attempts int not null default 0, next_attempt_at timestamptz null, last_error text null,
    fetched_at timestamptz null,
    waiting_from timestamptz null, waiting_to timestamptz null,
    primary key (kind, lat_index, lon_index));
create index if not exists ix_transit_tile_waiting on transit_tile (waiting_to) where state <> 'done';

-- A done tile holds its lines, and when they were fetched: a done tile without them would be found neither cached nor waiting, and the
-- stretch that needs it would be rebuilt again and again. Dropped and added again, which leaves it the same however often this runs.
alter table transit_tile drop constraint if exists transit_tile_done_has_lines;
alter table transit_tile add constraint transit_tile_done_has_lines check (state <> 'done' or (lines is not null and fetched_at is not null));

-- The stretch that waits to be rebuilt for the tiles that arrived since the last time it was asked for (transit_flushed_at). A tile that
-- arrives widens it, and the worker asks for it to be rebuilt once the backfill is done and no other tile is due to be fetched, or
-- 10 minutes after the last time, whichever comes first: tiles come one every 10 s or so, and the stretch of a tile near home can be the
-- whole history, which is not to be rebuilt for each of them.
alter table processing_state add column if not exists transit_ready_from timestamptz null;
alter table processing_state add column if not exists transit_ready_to timestamptz null;
alter table processing_state add column if not exists transit_flushed_at timestamptz null;
