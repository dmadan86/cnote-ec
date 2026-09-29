-- CreateEnum
CREATE TYPE "lead_capture_status" AS ENUM ('started', 'otp_sent', 'verified', 'converted', 'abandoned');

-- CreateTable
CREATE TABLE "lead_captures" (
    "id" UUID NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "person_id" UUID,
    "phone_hash" TEXT,
    "trigger" TEXT NOT NULL,
    "unlock" TEXT NOT NULL,
    "listing_id" UUID,
    "seller_business_id" UUID,
    "category_id" UUID,
    "enquiry_id" UUID,
    "status" "lead_capture_status" NOT NULL DEFAULT 'started',
    "follow_up_consent" BOOLEAN NOT NULL DEFAULT false,
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_captures_visitor_id_created_at_idx" ON "lead_captures"("visitor_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_captures_status_created_at_idx" ON "lead_captures"("status", "created_at");

-- CreateIndex
CREATE INDEX "lead_captures_trigger_created_at_idx" ON "lead_captures"("trigger", "created_at");

-- CreateIndex
CREATE INDEX "lead_captures_person_id_idx" ON "lead_captures"("person_id");

