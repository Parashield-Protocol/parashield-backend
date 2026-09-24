-- CreateTable
CREATE TABLE "WebhookRegistration" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "events" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookRegistration_isActive_idx" ON "WebhookRegistration"("isActive");
