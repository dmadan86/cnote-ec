-- CreateEnum
CREATE TYPE "sample_status" AS ENUM ('requested', 'accepted', 'declined', 'dispatched', 'delivered', 'approved', 'rejected', 'expired', 'cancelled');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "sample_dispatch_days" INTEGER,
ADD COLUMN     "sample_max_qty" INTEGER,
ADD COLUMN     "sample_min_buyer_tier" INTEGER;

-- CreateTable
CREATE TABLE "sample_requests" (
    "id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "buyer_person_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "listing_id" UUID,
    "subject" TEXT NOT NULL,
    "match_id" UUID,
    "enquiry_id" UUID,
    "quote_id" UUID,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT,
    "buyer_note" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "buyer_tier" INTEGER NOT NULL DEFAULT 0,
    "status" "sample_status" NOT NULL DEFAULT 'requested',
    "ship_name" TEXT,
    "ship_phone" TEXT,
    "ship_line1" TEXT,
    "ship_line2" TEXT,
    "ship_city" TEXT,
    "ship_pincode" TEXT,
    "amount_paise" BIGINT NOT NULL DEFAULT 0,
    "adjustable_against_bulk" BOOLEAN NOT NULL DEFAULT false,
    "payment_note" TEXT,
    "payment_received_at" TIMESTAMPTZ,
    "respond_by" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "responded_by_person_id" UUID,
    "decline_reason" TEXT,
    "decline_note" TEXT,
    "expected_dispatch_by" TIMESTAMPTZ,
    "courier" TEXT,
    "tracking_ref" TEXT,
    "dispatched_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "delivered_by" TEXT,
    "evaluated_at" TIMESTAMPTZ,
    "evaluated_by_person_id" UUID,
    "evaluation_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evaluation_notes" TEXT,
    "bulk_enquiry_id" UUID,
    "bulk_requested_at" TIMESTAMPTZ,
    "active_key" TEXT,
    "personal_data_purged_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_media" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_by_person_id" UUID NOT NULL,
    "purged_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_status_log" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "status" "sample_status" NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sample_requests_active_key_key" ON "sample_requests"("active_key");

-- CreateIndex
CREATE INDEX "sample_requests_buyer_business_id_created_at_idx" ON "sample_requests"("buyer_business_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sample_requests_seller_business_id_status_created_at_idx" ON "sample_requests"("seller_business_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sample_requests_status_respond_by_idx" ON "sample_requests"("status", "respond_by");

-- CreateIndex
CREATE INDEX "sample_requests_bulk_enquiry_id_idx" ON "sample_requests"("bulk_enquiry_id");

-- CreateIndex
CREATE INDEX "sample_requests_quote_id_idx" ON "sample_requests"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_media_key_key" ON "sample_media"("key");

-- CreateIndex
CREATE INDEX "sample_media_sample_id_idx" ON "sample_media"("sample_id");

-- CreateIndex
CREATE INDEX "sample_status_log_sample_id_created_at_idx" ON "sample_status_log"("sample_id", "created_at");

-- AddForeignKey
ALTER TABLE "sample_media" ADD CONSTRAINT "sample_media_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "sample_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_status_log" ADD CONSTRAINT "sample_status_log_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "sample_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

