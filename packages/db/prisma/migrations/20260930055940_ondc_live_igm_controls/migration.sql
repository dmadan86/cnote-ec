

-- AlterTable
ALTER TABLE "ondc_orders" ADD COLUMN     "fulfilment_state" TEXT;

-- CreateTable
CREATE TABLE "ondc_issues" (
    "id" UUID NOT NULL,
    "issue_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "bap_id" TEXT NOT NULL,
    "bap_uri" TEXT NOT NULL,
    "ondc_order_id" UUID,
    "seller_business_id" UUID,
    "category" TEXT NOT NULL,
    "sub_category" TEXT,
    "issue_type" TEXT NOT NULL DEFAULT 'ISSUE',
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "respondent_action" TEXT,
    "dispute_id" UUID,
    "needs_manual" BOOLEAN NOT NULL DEFAULT false,
    "resolution" JSONB,
    "expected_response_at" TIMESTAMPTZ NOT NULL,
    "expected_resolution_at" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "cascaded_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "received_emitted_at" TIMESTAMPTZ,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ondc_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ondc_controls" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ondc_controls_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ondc_issues_dispute_id_idx" ON "ondc_issues"("dispute_id");

-- CreateIndex
CREATE INDEX "ondc_issues_status_expected_resolution_at_idx" ON "ondc_issues"("status", "expected_resolution_at");

-- CreateIndex
CREATE INDEX "ondc_issues_ondc_order_id_idx" ON "ondc_issues"("ondc_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ondc_issues_bap_id_issue_id_key" ON "ondc_issues"("bap_id", "issue_id");

