-- CreateEnum
CREATE TYPE "domain_status" AS ENUM ('pending_dns', 'verifying', 'verified', 'provisioning_tls', 'active', 'misconfigured', 'removed');

-- DropIndex
DROP INDEX "storefronts_custom_domain_key";

-- AlterTable
ALTER TABLE "storefronts" DROP COLUMN "custom_domain",
DROP COLUMN "domain_verified_at",
DROP COLUMN "domain_verify_token";

-- CreateTable
CREATE TABLE "storefront_domains" (
    "id" UUID NOT NULL,
    "storefront_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "domain_status" NOT NULL DEFAULT 'pending_dns',
    "verify_token" TEXT NOT NULL,
    "expected_records" JSONB NOT NULL,
    "last_check" JSONB,
    "last_error" TEXT,
    "check_count" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMPTZ,
    "verified_at" TIMESTAMPTZ,
    "activated_at" TIMESTAMPTZ,
    "provider_ref" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_traffic_daily" (
    "storefront_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "pageviews" INTEGER NOT NULL DEFAULT 0,
    "unique_visitors" INTEGER NOT NULL DEFAULT 0,
    "by_source" JSONB NOT NULL DEFAULT '{}',
    "by_referrer" JSONB NOT NULL DEFAULT '{}',
    "by_page" JSONB NOT NULL DEFAULT '{}',
    "by_device" JSONB NOT NULL DEFAULT '{}',
    "bot_hits" JSONB NOT NULL DEFAULT '{}',
    "by_host_kind" JSONB NOT NULL DEFAULT '{}',
    "enquiries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "storefront_traffic_daily_pkey" PRIMARY KEY ("storefront_id","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "storefront_domains_hostname_key" ON "storefront_domains"("hostname");

-- CreateIndex
CREATE INDEX "storefront_domains_storefront_id_idx" ON "storefront_domains"("storefront_id");

-- CreateIndex
CREATE INDEX "storefront_domains_status_last_checked_at_idx" ON "storefront_domains"("status", "last_checked_at");

-- AddForeignKey
ALTER TABLE "storefront_domains" ADD CONSTRAINT "storefront_domains_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_traffic_daily" ADD CONSTRAINT "storefront_traffic_daily_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

