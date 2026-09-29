-- pgvector for embeddings (ADR-008/009)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('active', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "credit_reason" AS ENUM ('grant', 'consume', 'refund', 'expire');

-- CreateEnum
CREATE TYPE "moderation_status" AS ENUM ('pending', 'approved', 'review', 'rejected');

-- CreateEnum
CREATE TYPE "listing_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "enquiry_status" AS ENUM ('scoring', 'review', 'matched', 'unmatched', 'closed', 'rejected');

-- CreateEnum
CREATE TYPE "match_status" AS ENUM ('offered', 'accepted', 'declined', 'expired', 'refunded');

-- CreateEnum
CREATE TYPE "deal_outcome" AS ENUM ('won', 'lost', 'pending');

-- CreateEnum
CREATE TYPE "consent_purpose" AS ENUM ('matching', 'marketing', 'voice_retention', 'counterparty_sharing');

-- CreateEnum
CREATE TYPE "verification_kind" AS ENUM ('phone_otp', 'gstin', 'udyam', 'document', 'video_kyc', 'audit');

-- CreateEnum
CREATE TYPE "verification_status" AS ENUM ('pending', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('owner', 'staff');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('open', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "plans" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_price_paise" BIGINT NOT NULL,
    "monthly_credits" INTEGER NOT NULL,
    "features" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'active',
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "credit_reason" NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "lead_cap" INTEGER NOT NULL DEFAULT 3,
    "prohibited" BOOLEAN NOT NULL DEFAULT false,
    "attribute_schema" JSONB NOT NULL DEFAULT '{"fields":[]}',
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price_paise" BIGINT,
    "price_unit" TEXT,
    "moq" INTEGER,
    "moq_unit" TEXT,
    "hsn" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "status" "listing_status" NOT NULL DEFAULT 'draft',
    "moderation_status" "moderation_status" NOT NULL DEFAULT 'pending',
    "moderation_reason" TEXT,
    "embedding" vector(256),
    "embedding_version" TEXT,
    "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title",'') || ' ' || coalesce("description",''))) STORED,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiries" (
    "id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "buyer_person_id" UUID NOT NULL,
    "category_id" UUID,
    "title" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "quantity" INTEGER,
    "quantity_unit" TEXT,
    "target_price_paise" BIGINT,
    "delivery_city" TEXT,
    "delivery_pincode" TEXT,
    "needed_by" DATE,
    "language" TEXT NOT NULL DEFAULT 'en',
    "intent_score" INTEGER,
    "intent_reasons" JSONB NOT NULL DEFAULT '[]',
    "embedding" vector(256),
    "embedding_version" TEXT,
    "moderation_status" "moderation_status" NOT NULL DEFAULT 'pending',
    "status" "enquiry_status" NOT NULL DEFAULT 'scoring',
    "seller_cap" INTEGER NOT NULL DEFAULT 3,
    "buyer_picks" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "match_score" REAL NOT NULL,
    "status" "match_status" NOT NULL DEFAULT 'offered',
    "offered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respond_by" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "credit_txn_id" UUID,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_person_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "lead_time_days" INTEGER,
    "notes" TEXT,
    "valid_until" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_reports" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "reported_by_business_id" UUID NOT NULL,
    "outcome" "deal_outcome" NOT NULL,
    "value_paise" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persons" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "preferred_language" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "udyam" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "is_seller" BOOLEAN NOT NULL DEFAULT false,
    "is_buyer" BOOLEAN NOT NULL DEFAULT true,
    "verification_tier" SMALLINT NOT NULL DEFAULT 0,
    "trust_score" SMALLINT NOT NULL DEFAULT 50,
    "badge_active" BOOLEAN NOT NULL DEFAULT false,
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_members" (
    "business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'owner',

    CONSTRAINT "business_members_pkey" PRIMARY KEY ("business_id","person_id")
);

-- CreateTable
CREATE TABLE "verification_records" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "tier" SMALLINT NOT NULL,
    "kind" "verification_kind" NOT NULL,
    "status" "verification_status" NOT NULL,
    "provider" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "purpose" "consent_purpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_decisions" (
    "id" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_redacted" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "confidence" REAL NOT NULL,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_queue" (
    "id" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ai_decision_id" UUID,
    "status" "review_status" NOT NULL DEFAULT 'open',
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscriptions_business_id_status_idx" ON "subscriptions"("business_id", "status");

-- CreateIndex
CREATE INDEX "credit_ledger_business_id_created_at_idx" ON "credit_ledger"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "listings_seller_business_id_idx" ON "listings"("seller_business_id");

-- CreateIndex
CREATE INDEX "listings_category_id_status_idx" ON "listings"("category_id", "status");

-- CreateIndex
CREATE INDEX "enquiries_buyer_business_id_created_at_idx" ON "enquiries"("buyer_business_id", "created_at");

-- CreateIndex
CREATE INDEX "matches_seller_business_id_status_idx" ON "matches"("seller_business_id", "status");

-- CreateIndex
CREATE INDEX "matches_status_respond_by_idx" ON "matches"("status", "respond_by");

-- CreateIndex
CREATE UNIQUE INDEX "matches_enquiry_id_seller_business_id_key" ON "matches"("enquiry_id", "seller_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_match_id_key" ON "conversations"("match_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "persons_phone_key" ON "persons"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_gstin_key" ON "businesses"("gstin");

-- CreateIndex
CREATE INDEX "businesses_is_seller_trust_score_idx" ON "businesses"("is_seller", "trust_score");

-- CreateIndex
CREATE INDEX "verification_records_business_id_idx" ON "verification_records"("business_id");

-- CreateIndex
CREATE INDEX "consents_person_id_purpose_created_at_idx" ON "consents"("person_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "domain_events_published_at_id_idx" ON "domain_events"("published_at", "id");

-- CreateIndex
CREATE INDEX "domain_events_aggregate_type_aggregate_id_idx" ON "domain_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "ai_decisions_subject_type_subject_id_idx" ON "ai_decisions"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "review_queue_status_created_at_idx" ON "review_queue"("status", "created_at");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_business_id_fkey" FOREIGN KEY ("seller_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_buyer_business_id_fkey" FOREIGN KEY ("buyer_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_buyer_person_id_fkey" FOREIGN KEY ("buyer_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_seller_business_id_fkey" FOREIGN KEY ("seller_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_person_id_fkey" FOREIGN KEY ("sender_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_seller_business_id_fkey" FOREIGN KEY ("seller_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_reports" ADD CONSTRAINT "deal_reports_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_reports" ADD CONSTRAINT "deal_reports_reported_by_business_id_fkey" FOREIGN KEY ("reported_by_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_records" ADD CONSTRAINT "verification_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_ai_decision_id_fkey" FOREIGN KEY ("ai_decision_id") REFERENCES "ai_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Raw-SQL indexes Prisma cannot express (keep these in sync by hand)
CREATE INDEX "listings_search_tsv_idx" ON "listings" USING GIN ("search_tsv");
CREATE INDEX "listings_embedding_hnsw_idx" ON "listings" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "enquiries_embedding_hnsw_idx" ON "enquiries" USING hnsw ("embedding" vector_cosine_ops);
