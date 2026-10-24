CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS locationLog (
    time TIMESTAMPTZ NOT NULL, longitude DOUBLE PRECISION NOT NULL, latitude DOUBLE PRECISION NOT NULL,
    device text NOT NULL, speed DOUBLE PRECISION NULL, altitude numeric NOT NULL);
SELECT create_hypertable('locationLog', by_range('time'), if_not_exists => TRUE);
