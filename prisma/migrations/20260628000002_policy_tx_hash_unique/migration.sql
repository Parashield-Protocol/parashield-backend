-- AlterTable: add unique constraint on Policy.txHash to prevent duplicate on-chain tx records
CREATE UNIQUE INDEX "Policy_txHash_key" ON "Policy"("txHash") WHERE "txHash" IS NOT NULL;
