-- How many times in a row the backfill has started its current chunk without finishing it. Stored before the chunk runs,
-- so a process that is killed in the middle of it (out of memory) still counts.
ALTER TABLE processing_state ADD COLUMN IF NOT EXISTS backfill_chunk_attempts int NOT NULL DEFAULT 0;
