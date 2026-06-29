-- Prevent concurrent submitClaim requests from creating duplicate PENDING/PROCESSING
-- claims for the same policy (#154). A partial unique index is used so that terminal
-- statuses (PAID, REJECTED, FAILED, EXPIRED) do not block future retries.
CREATE UNIQUE INDEX "Claim_policyId_active_key"
  ON "Claim"("policyId")
  WHERE status IN ('PENDING', 'PROCESSING');
