BEGIN;

-- Bucketed idempotency for oracle readings (#172).
-- Existing rows are back-filled with their submittedAt truncated to the hour so
-- the new unique index can be created without data loss.
ALTER TABLE "OracleReading"
  ADD COLUMN IF NOT EXISTS "bucketStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "onChainSubmitted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "onChainTxHash" TEXT;

UPDATE "OracleReading" SET "bucketStart" = date_trunc('hour', "submittedAt");

-- Collapse any rows that would now collide, keeping the most recent per bucket.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "key", source, "bucketStart" ORDER BY "submittedAt" DESC, id
  ) AS rn
  FROM "OracleReading"
)
DELETE FROM "OracleReading" WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Replace the (key, source) unique index with the bucketed one so history is
-- retained per bucket while duplicates within a bucket stay impossible.
DROP INDEX IF EXISTS oracle_reading_key_source_unique;
DROP INDEX IF EXISTS "OracleReading_key_source_key";

CREATE UNIQUE INDEX IF NOT EXISTS "OracleReading_key_source_bucketStart_key"
  ON "OracleReading" ("key", source, "bucketStart");

COMMIT;
