-- CreateEnum
CREATE TYPE "quote_draft_status" AS ENUM ('pending', 'approved', 'discarded');

-- CreateEnum
CREATE TYPE "counter_proposal_status" AS ENUM ('proposed', 'sent', 'discarded');

-- CreateTable
CREATE TABLE "seller_price_book" (
    "id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "base_price_paise" BIGINT NOT NULL,
    "unit" TEXT NOT NULL,
    "tiers" JSONB NOT NULL DEFAULT '[]',
    "floor_price_paise" BIGINT NOT NULL,
    "moq" INTEGER,
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "delivery_terms" TEXT,
    "gst_percent" INTEGER,
    "gst_included" BOOLEAN NOT NULL DEFAULT false,
    "validity_days" INTEGER NOT NULL DEFAULT 7,
    "seeded" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "seller_price_book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_drafts" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "price_book_id" UUID,
    "status" "quote_draft_status" NOT NULL DEFAULT 'pending',
    "price_paise" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "moq" INTEGER,
    "lead_time_days" INTEGER,
    "shipping_terms" TEXT,
    "valid_until" DATE,
    "notes" TEXT,
    "rationale" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "bounds_check" JSONB NOT NULL DEFAULT '{}',
    "original" JSONB NOT NULL DEFAULT '{}',
    "ai_decision_id" UUID,
    "quote_id" UUID,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "edited_fields" INTEGER NOT NULL DEFAULT 0,
    "price_delta_pct" REAL,
    "notes_edit_distance" INTEGER NOT NULL DEFAULT 0,
    "decided_by_person_id" UUID,
    "decided_via" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_bounds" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "target_price_paise" BIGINT,
    "ceiling_price_paise" BIGINT,
    "max_lead_time_days" INTEGER,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "buyer_bounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_terms" (
    "quote_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "delivery_charge_paise" BIGINT,
    "delivery_included" BOOLEAN,
    "gst_percent" INTEGER,
    "gst_included" BOOLEAN,
    "payment_terms" TEXT,
    "confidence" REAL NOT NULL,
    "ai_decision_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_terms_pkey" PRIMARY KEY ("quote_id")
);

-- CreateTable
CREATE TABLE "counter_proposals" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "status" "counter_proposal_status" NOT NULL DEFAULT 'proposed',
    "quoted_price_paise" BIGINT NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "lead_time_days" INTEGER,
    "note" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "bounds_snapshot" JSONB NOT NULL DEFAULT '{}',
    "ai_decision_id" UUID,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "sent_by_person_id" UUID,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counter_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_action_log" (
    "id" UUID NOT NULL,
    "principal_business_id" UUID NOT NULL,
    "principal_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "enquiry_id" UUID,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "actor_person_id" UUID,
    "ai_decision_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_quote_timing" (
    "match_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ NOT NULL,
    "first_quote_at" TIMESTAMPTZ,
    "assisted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lead_quote_timing_pkey" PRIMARY KEY ("match_id")
);

-- CreateIndex
CREATE INDEX "seller_price_book_seller_business_id_active_idx" ON "seller_price_book"("seller_business_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "seller_price_book_seller_business_id_listing_id_key" ON "seller_price_book"("seller_business_id", "listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_drafts_match_id_key" ON "quote_drafts"("match_id");

-- CreateIndex
CREATE INDEX "quote_drafts_seller_business_id_status_created_at_idx" ON "quote_drafts"("seller_business_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "buyer_bounds_enquiry_id_key" ON "buyer_bounds"("enquiry_id");

-- CreateIndex
CREATE INDEX "buyer_bounds_buyer_business_id_idx" ON "buyer_bounds"("buyer_business_id");

-- CreateIndex
CREATE INDEX "quote_terms_enquiry_id_idx" ON "quote_terms"("enquiry_id");

-- CreateIndex
CREATE INDEX "counter_proposals_enquiry_id_status_idx" ON "counter_proposals"("enquiry_id", "status");

-- CreateIndex
CREATE INDEX "counter_proposals_buyer_business_id_created_at_idx" ON "counter_proposals"("buyer_business_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_action_log_principal_business_id_created_at_idx" ON "agent_action_log"("principal_business_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_action_log_enquiry_id_created_at_idx" ON "agent_action_log"("enquiry_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_quote_timing_conversation_id_idx" ON "lead_quote_timing"("conversation_id");

-- CreateIndex
CREATE INDEX "lead_quote_timing_seller_business_id_accepted_at_idx" ON "lead_quote_timing"("seller_business_id", "accepted_at");

