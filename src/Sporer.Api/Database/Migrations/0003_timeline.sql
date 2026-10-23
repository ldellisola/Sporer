CREATE TABLE place (
    id bigserial PRIMARY KEY, latitude double precision NOT NULL, longitude double precision NOT NULL,
    osm_name text NULL, address text NULL, city text NULL, country text NULL,
    user_name text NULL, merged_into_id bigint NULL REFERENCES place(id),
    geocode_state text NOT NULL DEFAULT 'pending' CHECK (geocode_state IN ('pending','done','failed')),
    geocode_attempts int NOT NULL DEFAULT 0, geocode_next_attempt_at timestamptz NULL,  -- NULL = due now
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE segment (
    id bigserial PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('stay','move','gap')),
    start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL,
    start_tz text NOT NULL, end_tz text NOT NULL,
    local_start_date date NOT NULL, local_end_date date NOT NULL,
    place_id bigint NULL REFERENCES place(id),
    latitude double precision NULL, longitude double precision NULL,
    mode text NULL CHECK (mode IN ('walk','cycle','drive','flight')),
    distance_m double precision NULL,
    geometry_detail jsonb NULL, geometry_coarse jsonb NULL,
    point_count int NOT NULL DEFAULT 0);
CREATE INDEX ix_segment_start ON segment (start_utc);
CREATE INDEX ix_segment_local_dates ON segment (local_start_date, local_end_date);
CREATE INDEX ix_segment_stays ON segment (start_utc) WHERE kind = 'stay';
CREATE TABLE geocode_cache (
    lat_key numeric(7,4) NOT NULL, lon_key numeric(8,4) NOT NULL, response jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (lat_key, lon_key));
CREATE TABLE processing_state (
    id int PRIMARY KEY CHECK (id = 1), algorithm_version text NULL,
    backfill_from timestamptz NULL, backfill_to timestamptz NULL, backfill_cursor timestamptz NULL,
    paused boolean NOT NULL DEFAULT false, last_run_at timestamptz NULL, last_error text NULL);
INSERT INTO processing_state (id) VALUES (1);
