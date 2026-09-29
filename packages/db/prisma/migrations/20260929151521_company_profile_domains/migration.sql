

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "cin" TEXT,
ADD COLUMN     "company_type" TEXT,
ADD COLUMN     "gst_last_checked_at" TIMESTAMPTZ,
ADD COLUMN     "gst_status" TEXT,
ADD COLUMN     "gst_verified_at" TIMESTAMPTZ,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "pan" TEXT,
ADD COLUMN     "registered_address" JSONB,
ADD COLUMN     "trade_name" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "storefronts" ADD COLUMN     "custom_domain" TEXT,
ADD COLUMN     "domain_verified_at" TIMESTAMPTZ,
ADD COLUMN     "domain_verify_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_custom_domain_key" ON "storefronts"("custom_domain");

