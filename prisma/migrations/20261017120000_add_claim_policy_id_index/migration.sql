-- Issue #672: Add index on Claim.policyId to support aggregate claims-count queries in policy listing
CREATE INDEX IF NOT EXISTS "Claim_policyId_idx" ON "Claim"("policyId");
