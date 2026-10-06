-- CreateEnum
CREATE TYPE "rate_contract_status" AS ENUM ('draft', 'proposed', 'active', 'expired', 'terminated');

-- CreateTable
CREATE TABLE "rate_contracts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "rate_contract_status" NOT NULL DEFAULT 'draft',
    "latest_revision" INTEGER NOT NULL DEFAULT 1,
    "active_revision" INTEGER,
    "source_quote_id" UUID,
    "renewed_from_id" UUID,
    "terminated_at" TIMESTAMPTZ,
    "terminated_by_business_id" UUID,
    "termination_reason" TEXT,
    "expired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_contract_sequences" (
    "buyer_business_id" UUID NOT NULL,
    "financial_year" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_contract_sequences_pkey" PRIMARY KEY ("buyer_business_id","financial_year")
);

-- CreateTable
CREATE TABLE "rate_contract_revisions" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "proposed_by_business_id" UUID NOT NULL,
    "proposed_by_person_id" UUID,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "payment_terms_days" INTEGER NOT NULL,
    "price_basis" TEXT NOT NULL,
    "value_cap_paise" BIGINT,
    "notes" TEXT,
    "change_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_contract_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_contract_items" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "item_key" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "listing_id" UUID,
    "description" TEXT NOT NULL,
    "hsn" TEXT,
    "unit" TEXT NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "gst_rate_bps" INTEGER NOT NULL,
    "moq" INTEGER,
    "quantity_cap" INTEGER,
    "variation_kind" TEXT NOT NULL DEFAULT 'fixed',
    "variation_cap_bps" INTEGER,
    "variation_note" TEXT,

    CONSTRAINT "rate_contract_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_contract_acceptances" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "person_id" UUID,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_contract_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_contract_call_offs" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "call_off_no" INTEGER NOT NULL,
    "order_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'placed',
    "taxable_paise" BIGINT NOT NULL,
    "placed_by_person_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ,

    CONSTRAINT "rate_contract_call_offs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_contract_call_off_lines" (
    "id" UUID NOT NULL,
    "call_off_id" UUID NOT NULL,
    "item_key" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "contract_price_paise" BIGINT NOT NULL,
    "applied_price_paise" BIGINT NOT NULL,
    "taxable_paise" BIGINT NOT NULL,

    CONSTRAINT "rate_contract_call_off_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_contract_alerts" (
    "contract_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_contract_alerts_pkey" PRIMARY KEY ("contract_id","scope","threshold")
);

-- CreateIndex
CREATE INDEX "rate_contracts_buyer_business_id_created_at_idx" ON "rate_contracts"("buyer_business_id", "created_at");

-- CreateIndex
CREATE INDEX "rate_contracts_seller_business_id_created_at_idx" ON "rate_contracts"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "rate_contracts_status_idx" ON "rate_contracts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contracts_buyer_business_id_number_key" ON "rate_contracts"("buyer_business_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_revisions_contract_id_revision_key" ON "rate_contract_revisions"("contract_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_items_revision_id_line_no_key" ON "rate_contract_items"("revision_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_items_revision_id_item_key_key" ON "rate_contract_items"("revision_id", "item_key");

-- CreateIndex
CREATE INDEX "rate_contract_acceptances_revision_id_created_at_idx" ON "rate_contract_acceptances"("revision_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_call_offs_order_id_key" ON "rate_contract_call_offs"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_call_offs_contract_id_call_off_no_key" ON "rate_contract_call_offs"("contract_id", "call_off_no");

-- CreateIndex
CREATE INDEX "rate_contract_call_off_lines_item_key_idx" ON "rate_contract_call_off_lines"("item_key");

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_call_off_lines_call_off_id_line_no_key" ON "rate_contract_call_off_lines"("call_off_id", "line_no");

-- AddForeignKey
ALTER TABLE "rate_contract_revisions" ADD CONSTRAINT "rate_contract_revisions_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "rate_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_contract_items" ADD CONSTRAINT "rate_contract_items_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "rate_contract_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_contract_acceptances" ADD CONSTRAINT "rate_contract_acceptances_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "rate_contract_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_contract_call_offs" ADD CONSTRAINT "rate_contract_call_offs_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "rate_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_contract_call_offs" ADD CONSTRAINT "rate_contract_call_offs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_contract_call_off_lines" ADD CONSTRAINT "rate_contract_call_off_lines_call_off_id_fkey" FOREIGN KEY ("call_off_id") REFERENCES "rate_contract_call_offs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_contract_alerts" ADD CONSTRAINT "rate_contract_alerts_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "rate_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

