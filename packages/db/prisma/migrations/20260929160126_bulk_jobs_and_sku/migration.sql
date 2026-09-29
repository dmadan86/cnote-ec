-- CreateEnum
CREATE TYPE "bulk_job_kind" AS ENUM ('import', 'export');

-- CreateEnum
CREATE TYPE "bulk_job_status" AS ENUM ('uploaded', 'validating', 'validated', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'expired');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "sku" TEXT;

-- CreateTable
CREATE TABLE "bulk_jobs" (
    "id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "kind" "bulk_job_kind" NOT NULL,
    "status" "bulk_job_status" NOT NULL DEFAULT 'uploaded',
    "format" TEXT NOT NULL,
    "original_name" TEXT,
    "source_key" TEXT,
    "result_key" TEXT,
    "error_report_key" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "sample_errors" JSONB NOT NULL DEFAULT '[]',
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "bulk_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bulk_jobs_seller_business_id_created_at_idx" ON "bulk_jobs"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "bulk_jobs_status_created_at_idx" ON "bulk_jobs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "listings_seller_business_id_sku_key" ON "listings"("seller_business_id", "sku");

