-- Version product premium-rate templates and preserve the exact template used
-- by every policy. Existing policies are backfilled from their current product.
ALTER TABLE "Product"
ADD COLUMN "premiumRateVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Policy"
ADD COLUMN "premiumRate" INTEGER,
ADD COLUMN "premiumRateVersion" INTEGER;

UPDATE "Policy" AS policy
SET
  "premiumRate" = product."premiumRate",
  "premiumRateVersion" = product."premiumRateVersion"
FROM "Product" AS product
WHERE policy."productId" = product."id";

ALTER TABLE "Policy"
ALTER COLUMN "premiumRate" SET NOT NULL,
ALTER COLUMN "premiumRate" SET DEFAULT 0,
ALTER COLUMN "premiumRateVersion" SET NOT NULL,
ALTER COLUMN "premiumRateVersion" SET DEFAULT 1;
