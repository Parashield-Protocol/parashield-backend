BEGIN;

-- Remove duplicate OracleReading rows, keeping the most recent submittedAt per (key, source)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "key", source ORDER BY "submittedAt" DESC, id) AS rn
  FROM "OracleReading"
)
DELETE FROM "OracleReading" WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Add unique index on (key, source) to enforce deduplication going forward
CREATE UNIQUE INDEX IF NOT EXISTS oracle_reading_key_source_unique ON "OracleReading" ("key", source);

COMMIT;
