-- CreateEnum
CREATE TYPE "agent_side" AS ENUM ('buyer', 'seller');

-- CreateEnum
CREATE TYPE "agent_mandate_status" AS ENUM ('active', 'paused', 'revoked', 'expired', 'completed', 'suspended');

-- CreateEnum
CREATE TYPE "agent_negotiation_status" AS ENUM ('open', 'agreed', 'accepted', 'rejected', 'withdrawn', 'expired');

-- CreateEnum
CREATE TYPE "agent_message_type" AS ENUM ('offer', 'counter', 'accept', 'reject', 'withdraw');

-- CreateEnum
CREATE TYPE "agent_confirmation" AS ENUM ('pending', 'human', 'auto', 'declined');

-- CreateEnum
CREATE TYPE "agent_driver" AS ENUM ('internal', 'external');

-- CreateTable
CREATE TABLE "agent_mandate" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "side" "agent_side" NOT NULL,
    "status" "agent_mandate_status" NOT NULL DEFAULT 'active',
    "name" TEXT NOT NULL,
    "created_by_person_id" UUID NOT NULL,
    "category_slug" TEXT,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "quantity" INTEGER,
    "unit" TEXT,
    "target_price_paise" BIGINT,
    "limit_price_paise" BIGINT,
    "max_lead_time_days" INTEGER,
    "max_discount_pct" INTEGER,
    "capacity_qty" INTEGER,
    "price_book_id" UUID,
    "approved_seller_ids" JSONB NOT NULL DEFAULT '[]',
    "max_rounds" INTEGER NOT NULL DEFAULT 6,
    "recurrence_days" INTEGER,
    "next_run_at" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "auto_accept" BOOLEAN NOT NULL DEFAULT false,
    "auto_accept_limit_paise" BIGINT,
    "consented_at" TIMESTAMPTZ NOT NULL,
    "auto_accept_consent_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_mandate_change" (
    "id" UUID NOT NULL,
    "mandate_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_person_id" UUID,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_mandate_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run" (
    "id" UUID NOT NULL,
    "mandate_id" UUID NOT NULL,
    "run_key" TEXT NOT NULL,
    "enquiry_id" UUID,
    "outcome" TEXT NOT NULL DEFAULT 'started',
    "detail" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_negotiation" (
    "id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "buyer_mandate_id" UUID NOT NULL,
    "seller_mandate_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "buyer_driver" "agent_driver" NOT NULL DEFAULT 'internal',
    "seller_driver" "agent_driver" NOT NULL DEFAULT 'internal',
    "initiated_by" "agent_side" NOT NULL,
    "start_key" TEXT,
    "status" "agent_negotiation_status" NOT NULL DEFAULT 'open',
    "round" INTEGER NOT NULL DEFAULT 0,
    "max_rounds" INTEGER NOT NULL,
    "turn" "agent_side",
    "buyer_private" JSONB NOT NULL,
    "seller_private" JSONB NOT NULL,
    "last_offer" JSONB,
    "agreed_terms" JSONB,
    "agreed_price_paise" BIGINT,
    "buyer_confirmation" "agent_confirmation" NOT NULL DEFAULT 'pending',
    "seller_confirmation" "agent_confirmation" NOT NULL DEFAULT 'pending',
    "quote_id" UUID,
    "order_id" UUID,
    "realise_error" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_negotiation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_message" (
    "id" UUID NOT NULL,
    "negotiation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "side" "agent_side" NOT NULL,
    "type" "agent_message_type" NOT NULL,
    "price_paise" BIGINT,
    "quantity" INTEGER,
    "terms" JSONB,
    "idempotency_key" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "api_key_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_activity" (
    "id" UUID NOT NULL,
    "principal_business_id" UUID NOT NULL,
    "principal_side" "agent_side" NOT NULL,
    "action" TEXT NOT NULL,
    "mandate_id" UUID,
    "negotiation_id" UUID,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "actor_person_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_suspension" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "business_id" UUID,
    "reason" TEXT NOT NULL,
    "suspended_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ,

    CONSTRAINT "agent_suspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_anomaly" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "negotiation_id" UUID,
    "api_key_id" TEXT,
    "kind" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_anomaly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_mandate_business_id_side_status_idx" ON "agent_mandate"("business_id", "side", "status");

-- CreateIndex
CREATE INDEX "agent_mandate_status_next_run_at_idx" ON "agent_mandate"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "agent_mandate_side_status_category_slug_idx" ON "agent_mandate"("side", "status", "category_slug");

-- CreateIndex
CREATE INDEX "agent_mandate_change_mandate_id_created_at_idx" ON "agent_mandate_change"("mandate_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_mandate_change_business_id_created_at_idx" ON "agent_mandate_change"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_mandate_id_run_key_key" ON "agent_run"("mandate_id", "run_key");

-- CreateIndex
CREATE INDEX "agent_negotiation_buyer_business_id_status_idx" ON "agent_negotiation"("buyer_business_id", "status");

-- CreateIndex
CREATE INDEX "agent_negotiation_seller_business_id_status_idx" ON "agent_negotiation"("seller_business_id", "status");

-- CreateIndex
CREATE INDEX "agent_negotiation_status_expires_at_idx" ON "agent_negotiation"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_negotiation_match_id_key" ON "agent_negotiation"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_negotiation_buyer_business_id_start_key_key" ON "agent_negotiation"("buyer_business_id", "start_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_message_negotiation_id_seq_key" ON "agent_message"("negotiation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "agent_message_negotiation_id_side_idempotency_key_key" ON "agent_message"("negotiation_id", "side", "idempotency_key");

-- CreateIndex
CREATE INDEX "agent_activity_principal_business_id_created_at_idx" ON "agent_activity"("principal_business_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_activity_negotiation_id_created_at_idx" ON "agent_activity"("negotiation_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_suspension_kind_target_id_lifted_at_idx" ON "agent_suspension"("kind", "target_id", "lifted_at");

-- CreateIndex
CREATE INDEX "agent_suspension_business_id_lifted_at_idx" ON "agent_suspension"("business_id", "lifted_at");

-- CreateIndex
CREATE INDEX "agent_anomaly_business_id_created_at_idx" ON "agent_anomaly"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_anomaly_negotiation_id_idx" ON "agent_anomaly"("negotiation_id");

