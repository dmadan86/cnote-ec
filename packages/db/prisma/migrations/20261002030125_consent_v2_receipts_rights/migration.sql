-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "consent_purpose" ADD VALUE 'analytics_cookies';
ALTER TYPE "consent_purpose" ADD VALUE 'marketing_cookies';

-- AlterTable
ALTER TABLE "cookie_consent_receipts" ADD COLUMN     "client_at" INTEGER,
ADD COLUMN     "registry_hash" TEXT;

-- AlterTable
ALTER TABLE "grievance_tickets" ADD COLUMN     "consent_id" TEXT,
ADD COLUMN     "request_type" TEXT NOT NULL DEFAULT 'complaint',
ADD COLUMN     "sla_days" INTEGER NOT NULL DEFAULT 15;

-- CreateIndex
CREATE UNIQUE INDEX "cookie_consent_receipts_consent_id_client_at_key" ON "cookie_consent_receipts"("consent_id", "client_at");

-- CreateIndex
CREATE INDEX "grievance_tickets_request_type_status_idx" ON "grievance_tickets"("request_type", "status");


-- Backfill: tickets raised before request types existed (category doubles as the right being exercised)
UPDATE "grievance_tickets" SET "request_type" = "category" WHERE "category" IN ('access', 'correction', 'erasure');
UPDATE "grievance_tickets" SET "request_type" = 'withdraw_consent' WHERE "category" = 'consent';
