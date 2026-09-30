

-- CreateTable
CREATE TABLE "credit_consent_links" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ,

    CONSTRAINT "credit_consent_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_scores" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "feature_hash" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_applications" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "escrow_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "counterparty_business_id" UUID,
    "order_amount_paise" BIGINT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "tenor_days" INTEGER NOT NULL,
    "partner" TEXT NOT NULL,
    "partner_ref" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "score_id" UUID,
    "accepted_offer_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_offers" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "partner_offer_ref" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "apr_bps" INTEGER NOT NULL,
    "tenor_days" INTEGER NOT NULL,
    "processing_fee_paise" BIGINT NOT NULL,
    "other_fees_paise" BIGINT NOT NULL,
    "interest_paise" BIGINT NOT NULL,
    "total_repayable_paise" BIGINT NOT NULL,
    "kfs" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "accepted_by_person_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_loans" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "escrow_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_amount_paise" BIGINT NOT NULL,
    "partner" TEXT NOT NULL,
    "partner_loan_ref" TEXT NOT NULL,
    "principal_paise" BIGINT NOT NULL,
    "apr_bps" INTEGER NOT NULL,
    "tenor_days" INTEGER NOT NULL,
    "total_repayable_paise" BIGINT NOT NULL,
    "repaid_paise" BIGINT NOT NULL DEFAULT 0,
    "written_off_paise" BIGINT NOT NULL DEFAULT 0,
    "disbursed_at" TIMESTAMPTZ NOT NULL,
    "due_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL,
    "dpd" INTEGER NOT NULL DEFAULT 0,
    "last_dpd_bucket" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "credit_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_repayments" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "paid_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_assignments" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "escrow_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "partner" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "credit_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_webhook_events" (
    "id" UUID NOT NULL,
    "partner" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_partner_shares" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "partner" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_partner_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_consent_links_business_id_idx" ON "credit_consent_links"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_consent_links_business_id_person_id_key" ON "credit_consent_links"("business_id", "person_id");

-- CreateIndex
CREATE INDEX "credit_scores_business_id_computed_at_idx" ON "credit_scores"("business_id", "computed_at" DESC);

-- CreateIndex
CREATE INDEX "credit_applications_business_id_created_at_idx" ON "credit_applications"("business_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "credit_applications_escrow_id_product_idx" ON "credit_applications"("escrow_id", "product");

-- CreateIndex
CREATE INDEX "credit_applications_status_idx" ON "credit_applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_applications_partner_partner_ref_key" ON "credit_applications"("partner", "partner_ref");

-- CreateIndex
CREATE INDEX "credit_offers_application_id_idx" ON "credit_offers"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_offers_application_id_partner_offer_ref_key" ON "credit_offers"("application_id", "partner_offer_ref");

-- CreateIndex
CREATE UNIQUE INDEX "credit_loans_application_id_key" ON "credit_loans"("application_id");

-- CreateIndex
CREATE INDEX "credit_loans_business_id_idx" ON "credit_loans"("business_id");

-- CreateIndex
CREATE INDEX "credit_loans_status_due_at_idx" ON "credit_loans"("status", "due_at");

-- CreateIndex
CREATE INDEX "credit_loans_escrow_id_idx" ON "credit_loans"("escrow_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_loans_partner_partner_loan_ref_key" ON "credit_loans"("partner", "partner_loan_ref");

-- CreateIndex
CREATE INDEX "credit_repayments_loan_id_idx" ON "credit_repayments"("loan_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_repayments_loan_id_event_key_key" ON "credit_repayments"("loan_id", "event_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_assignments_loan_id_key" ON "credit_assignments"("loan_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_assignments_escrow_id_key" ON "credit_assignments"("escrow_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_webhook_events_partner_event_id_key" ON "credit_webhook_events"("partner", "event_id");

-- CreateIndex
CREATE INDEX "credit_partner_shares_business_id_idx" ON "credit_partner_shares"("business_id");

-- CreateIndex
CREATE INDEX "credit_partner_shares_application_id_idx" ON "credit_partner_shares"("application_id");

