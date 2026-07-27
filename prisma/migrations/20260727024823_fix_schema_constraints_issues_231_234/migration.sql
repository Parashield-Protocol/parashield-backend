-- AlterTable: Add unique constraint to Claim.txHash (#231)
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_txHash_key" UNIQUE ("txHash");

-- CreateEnum: Create ProductStatus enum (#233)
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEPRECATED');

-- AlterTable: Change Product numeric fields from String to Decimal and status to enum (#232, #233)
-- Step 1: Add new columns with correct types
ALTER TABLE "Product" ADD COLUMN "threshold_new" DECIMAL(20,7);
ALTER TABLE "Product" ADD COLUMN "coverageMin_new" DECIMAL(20,7);
ALTER TABLE "Product" ADD COLUMN "coverageMax_new" DECIMAL(20,7);
ALTER TABLE "Product" ADD COLUMN "status_new" "ProductStatus" DEFAULT 'ACTIVE';

-- Step 2: Migrate data from old columns to new (convert String to Decimal, "Active" to ACTIVE)
UPDATE "Product" SET "threshold_new" = CAST("threshold" AS DECIMAL(20,7));
UPDATE "Product" SET "coverageMin_new" = CAST("coverageMin" AS DECIMAL(20,7));
UPDATE "Product" SET "coverageMax_new" = CAST("coverageMax" AS DECIMAL(20,7));
UPDATE "Product" SET "status_new" = 
  CASE 
    WHEN UPPER("status") = 'ACTIVE' THEN 'ACTIVE'::"ProductStatus"
    WHEN UPPER("status") = 'INACTIVE' THEN 'INACTIVE'::"ProductStatus"
    ELSE 'DEPRECATED'::"ProductStatus"
  END;

-- Step 3: Drop old columns and rename new columns
ALTER TABLE "Product" DROP COLUMN "threshold";
ALTER TABLE "Product" DROP COLUMN "coverageMin";
ALTER TABLE "Product" DROP COLUMN "coverageMax";
ALTER TABLE "Product" DROP COLUMN "status";

ALTER TABLE "Product" RENAME COLUMN "threshold_new" TO "threshold";
ALTER TABLE "Product" RENAME COLUMN "coverageMin_new" TO "coverageMin";
ALTER TABLE "Product" RENAME COLUMN "coverageMax_new" TO "coverageMax";
ALTER TABLE "Product" RENAME COLUMN "status_new" TO "status";

-- Step 4: Set NOT NULL constraints on the numeric columns
ALTER TABLE "Product" ALTER COLUMN "threshold" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "coverageMin" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "coverageMax" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "status" SET NOT NULL;

-- CreateIndex: Add index on Product.category (#234)
CREATE INDEX "Product_category_idx" ON "Product"("category");
