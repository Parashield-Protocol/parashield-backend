-- Optimistic-lock counter for Policy. Every status write increments it, and
-- the claim flows guard their policy writes on the version they read, so a
-- policy that was reverted PROCESSING -> ACTIVE and re-gated to PROCESSING by
-- another worker (same status, different claim attempt) can't be clobbered by
-- the original, slower attempt. See "Transaction strategy" in README.md.
ALTER TABLE "Policy" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
