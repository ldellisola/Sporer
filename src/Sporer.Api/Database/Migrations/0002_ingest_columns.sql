ALTER TABLE locationLog ADD COLUMN IF NOT EXISTS horizontal_accuracy double precision NULL;
ALTER TABLE locationLog ADD COLUMN IF NOT EXISTS motion text[] NULL;
CREATE TABLE dirty_range (
    id bigserial PRIMARY KEY, from_utc timestamptz NOT NULL, to_utc timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NULL, last_error text NULL);  -- NULL = due now
