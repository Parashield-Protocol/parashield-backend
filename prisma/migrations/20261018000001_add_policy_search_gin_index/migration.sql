-- Issue #731: Add GIN index for PostgreSQL full-text search on Policy
CREATE INDEX IF NOT EXISTS "policy_search_gin_idx" ON "Policy" USING gin(
  to_tsvector('english', coalesce("oracleKey", '') || ' ' || coalesce("policyholder", '') || ' ' || coalesce("txHash", ''))
);
