-- CreateEnum
CREATE TYPE "compliance_case_status" AS ENUM ('open', 'in_progress', 'resolved', 'rejected');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('recorded', 'confirmed', 'dispatched', 'delivered', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "voice_notes" (
    "id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "storage_key" TEXT,
    "mime_type" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "language" TEXT,
    "transcript" TEXT,
    "transcript_confidence" REAL,
    "listing_id" UUID,
    "retain_audio" BOOLEAN NOT NULL DEFAULT false,
    "purge_after" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grievance_tickets" (
    "id" UUID NOT NULL,
    "person_id" UUID,
    "contact_email" TEXT,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "compliance_case_status" NOT NULL DEFAULT 'open',
    "due_at" TIMESTAMPTZ NOT NULL,
    "resolution" TEXT,
    "handled_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grievance_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_appeals" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "business_id" UUID,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "compliance_case_status" NOT NULL DEFAULT 'open',
    "decision_note" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_runs" (
    "id" UUID NOT NULL,
    "policy" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "purged" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "error" TEXT,

    CONSTRAINT "retention_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_daily" (
    "metric" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,
    "numerator" DOUBLE PRECISION,
    "denominator" DOUBLE PRECISION,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_daily_pkey" PRIMARY KEY ("metric","day","dimension")
);

-- CreateTable
CREATE TABLE "metric_alerts" (
    "id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "quote_id" UUID,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "settlement" TEXT NOT NULL DEFAULT 'off_platform',
    "status" "order_status" NOT NULL DEFAULT 'recorded',
    "price_paise" BIGINT,
    "quantity" INTEGER,
    "unit" TEXT,
    "total_paise" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "buyer_confirmed_at" TIMESTAMPTZ,
    "seller_confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" UUID NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "person_id" UUID,
    "state" JSONB NOT NULL DEFAULT '{}',
    "language" TEXT NOT NULL DEFAULT 'en',
    "window_until" TIMESTAMPTZ,
    "opted_out_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "provider_id" TEXT,
    "kind" TEXT NOT NULL,
    "body" TEXT,
    "media_key" TEXT,
    "template" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "cost_paise" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_notes_storage_key_key" ON "voice_notes"("storage_key");

-- CreateIndex
CREATE INDEX "voice_notes_seller_business_id_created_at_idx" ON "voice_notes"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "voice_notes_purge_after_idx" ON "voice_notes"("purge_after");

-- CreateIndex
CREATE INDEX "grievance_tickets_status_due_at_idx" ON "grievance_tickets"("status", "due_at");

-- CreateIndex
CREATE INDEX "moderation_appeals_status_created_at_idx" ON "moderation_appeals"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_appeals_subject_type_subject_id_person_id_key" ON "moderation_appeals"("subject_type", "subject_id", "person_id");

-- CreateIndex
CREATE INDEX "retention_runs_policy_started_at_idx" ON "retention_runs"("policy", "started_at");

-- CreateIndex
CREATE INDEX "metric_daily_day_idx" ON "metric_daily"("day");

-- CreateIndex
CREATE INDEX "metric_alerts_resolved_at_created_at_idx" ON "metric_alerts"("resolved_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "metric_alerts_metric_day_key" ON "metric_alerts"("metric", "day");

-- CreateIndex
CREATE INDEX "orders_buyer_business_id_created_at_idx" ON "orders"("buyer_business_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_seller_business_id_created_at_idx" ON "orders"("seller_business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_match_id_key" ON "orders"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_phone_hash_key" ON "whatsapp_contacts"("phone_hash");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_person_id_idx" ON "whatsapp_contacts"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_id_key" ON "whatsapp_messages"("provider_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_contact_id_created_at_idx" ON "whatsapp_messages"("contact_id", "created_at");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "whatsapp_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

