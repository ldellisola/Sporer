-- Do not forget to create timescaledb extension
CREATE EXTENSION if not exists timescaledb;

-- We start by creating a regular SQL table
CREATE TABLE locationLog (
                            time      TIMESTAMPTZ       NOT NULL,
                            longitude DOUBLE precision  NOT NULL,
                            latitude  DOUBLE PRECISION  NOT NULL,
                            device    text              NOT NULL,
                            speed     DOUBLE PRECISION  NULL,
                            altitude  numeric           NOT NULL
);

-- Then we convert it into a hypertable that is partitioned by time
SELECT create_hypertable('locationLog', by_range('time'));