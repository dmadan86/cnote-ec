-- CreateEnum
CREATE TYPE "goods_return_status" AS ENUM ('requested', 'approved', 'rejected', 'cancelled', 'shipped', 'received', 'credited');

-- AlterTable
ALTER TABLE "supplier_invoices" ADD COLUMN     "credited_paise" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "escrow_return_refunds" (
    "credit_note_id" UUID NOT NULL,
    "escrow_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_return_refunds_pkey" PRIMARY KEY ("credit_note_id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "buyer_business_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("buyer_business_id","kind","financial_year")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "received_on" DATE NOT NULL,
    "receiver_name" TEXT NOT NULL,
    "delivery_note_ref" TEXT,
    "note" TEXT,
    "confirmed_delivery" BOOLEAN NOT NULL DEFAULT false,
    "created_by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "po_line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "received_qty" INTEGER NOT NULL,
    "accepted_qty" INTEGER NOT NULL,
    "rejected_qty" INTEGER NOT NULL,
    "reject_reason" TEXT,
    "reject_note" TEXT,
    "unit_price_paise" BIGINT NOT NULL,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_photos" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "po_line_no" INTEGER,
    "key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "po_line_no" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "taxable_paise" BIGINT NOT NULL,

    CONSTRAINT "supplier_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_match_settings" (
    "buyer_business_id" UUID NOT NULL,
    "qty_tolerance_bps" INTEGER NOT NULL,
    "price_tolerance_bps" INTEGER NOT NULL,
    "block_pending_grn" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_person_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buyer_match_settings_pkey" PRIMARY KEY ("buyer_business_id")
);

-- CreateTable
CREATE TABLE "invoice_match_overrides" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_match_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_returns" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "receipt_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "status" "goods_return_status" NOT NULL DEFAULT 'requested',
    "reason_code" TEXT NOT NULL,
    "reason_note" TEXT,
    "estimated_paise" BIGINT NOT NULL,
    "requested_by_person_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ,
    "decided_by_person_id" UUID,
    "decision_note" TEXT,
    "ship_courier" TEXT,
    "ship_tracking_ref" TEXT,
    "shipped_at" TIMESTAMPTZ,
    "received_back_at" TIMESTAMPTZ,
    "credited_at" TIMESTAMPTZ,
    "dispute_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_return_lines" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "po_line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,

    CONSTRAINT "goods_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_credit_notes" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "note_date" DATE NOT NULL,
    "taxable_paise" BIGINT NOT NULL,
    "gst_paise" BIGINT NOT NULL,
    "total_paise" BIGINT NOT NULL,
    "irn" TEXT,
    "recorded_by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "escrow_return_refunds_escrow_id_idx" ON "escrow_return_refunds"("escrow_id");

-- CreateIndex
CREATE INDEX "goods_receipts_purchase_order_id_created_at_idx" ON "goods_receipts"("purchase_order_id", "created_at");

-- CreateIndex
CREATE INDEX "goods_receipts_buyer_business_id_created_at_idx" ON "goods_receipts"("buyer_business_id", "created_at");

-- CreateIndex
CREATE INDEX "goods_receipts_seller_business_id_created_at_idx" ON "goods_receipts"("seller_business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_buyer_business_id_number_key" ON "goods_receipts"("buyer_business_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_receipt_id_po_line_no_key" ON "goods_receipt_lines"("receipt_id", "po_line_no");

-- CreateIndex
CREATE INDEX "goods_receipt_photos_receipt_id_created_at_idx" ON "goods_receipt_photos"("receipt_id", "created_at");

-- CreateIndex
CREATE INDEX "supplier_invoice_lines_invoice_id_po_line_no_idx" ON "supplier_invoice_lines"("invoice_id", "po_line_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_lines_invoice_id_line_no_key" ON "supplier_invoice_lines"("invoice_id", "line_no");

-- CreateIndex
CREATE INDEX "invoice_match_overrides_invoice_id_created_at_idx" ON "invoice_match_overrides"("invoice_id", "created_at");

-- CreateIndex
CREATE INDEX "goods_returns_buyer_business_id_status_created_at_idx" ON "goods_returns"("buyer_business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "goods_returns_seller_business_id_status_created_at_idx" ON "goods_returns"("seller_business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "goods_returns_receipt_id_idx" ON "goods_returns"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_returns_buyer_business_id_number_key" ON "goods_returns"("buyer_business_id", "number");

-- CreateIndex
CREATE INDEX "goods_return_lines_return_id_idx" ON "goods_return_lines"("return_id");

-- CreateIndex
CREATE INDEX "goods_return_lines_receipt_line_id_idx" ON "goods_return_lines"("receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_credit_notes_return_id_key" ON "return_credit_notes"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_credit_notes_irn_key" ON "return_credit_notes"("irn");

-- CreateIndex
CREATE INDEX "return_credit_notes_invoice_id_idx" ON "return_credit_notes"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_credit_notes_seller_business_id_financial_year_numbe_key" ON "return_credit_notes"("seller_business_id", "financial_year", "number");

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_photos" ADD CONSTRAINT "goods_receipt_photos_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_match_overrides" ADD CONSTRAINT "invoice_match_overrides_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_returns" ADD CONSTRAINT "goods_returns_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_return_lines" ADD CONSTRAINT "goods_return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "goods_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_return_lines" ADD CONSTRAINT "goods_return_lines_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "goods_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_credit_notes" ADD CONSTRAINT "return_credit_notes_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "goods_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_credit_notes" ADD CONSTRAINT "return_credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

