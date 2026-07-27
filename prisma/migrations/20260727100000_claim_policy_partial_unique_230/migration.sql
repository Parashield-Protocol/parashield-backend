-- Issue #230: Add partial-unique index on Claim.policyId for non-terminal statuses.
--
-- Prisma schema @@unique does not support WHERE clauses, so this constraint
-- is expressed as a raw migration rather than in schema.prisma.
-- The index prevents two PENDING or PROCESSING claims from being inserted
-- for the same policy concurrently, closing the race window between the
-- application-layer duplicate guard and the DB write.
--
-- Terminal statuses (PAID, REJECTED, FAILED, EXPIRED) are intentionally
-- excluded so historical claims can coexist with a new active claim.

CREATE UNIQUE INDEX "claim_policy_non_terminal_unique"
  ON "Claim" ("policyId")
  WHERE "status" IN ('PENDING', 'PROCESSING');
