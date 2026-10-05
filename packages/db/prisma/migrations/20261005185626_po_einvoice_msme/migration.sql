-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('issued', 'acknowledged', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "supplier_invoice_status" AS ENUM ('open', 'paid', 'void');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "msme_category" TEXT,
ADD COLUMN     "msme_declared_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivered_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'issued',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by_business_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_versions" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "payment_terms_days" INTEGER NOT NULL,
    "expected_delivery" DATE,
    "buyer" JSONB NOT NULL,
    "seller" JSONB NOT NULL,
    "delivery_address" JSONB NOT NULL,
    "place_of_supply" TEXT NOT NULL,
    "intra_state" BOOLEAN NOT NULL,
    "taxable_paise" BIGINT NOT NULL,
    "cgst_paise" BIGINT NOT NULL,
    "sgst_paise" BIGINT NOT NULL,
    "igst_paise" BIGINT NOT NULL,
    "total_paise" BIGINT NOT NULL,
    "notes" TEXT,
    "pdf_key" TEXT,
    "pdf_sha256" TEXT,
    "created_by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "hsn" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "price_includes_gst" BOOLEAN NOT NULL DEFAULT false,
    "gst_rate_bps" INTEGER NOT NULL,
    "taxable_paise" BIGINT NOT NULL,
    "tax_paise" BIGINT NOT NULL,
    "total_paise" BIGINT NOT NULL,
    "quote_id" UUID,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_acks" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_sequences" (
    "buyer_business_id" UUID NOT NULL,
    "financial_year" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_sequences_pkey" PRIMARY KEY ("buyer_business_id","financial_year")
);

-- CreateTable
CREATE TABLE "supplier_invoices" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "po_version" INTEGER NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "financial_year" TEXT NOT NULL,
    "taxable_paise" BIGINT NOT NULL,
    "gst_paise" BIGINT NOT NULL,
    "total_paise" BIGINT NOT NULL,
    "status" "supplier_invoice_status" NOT NULL DEFAULT 'open',
    "void_reason" TEXT,
    "file_key" TEXT,
    "file_name" TEXT,
    "file_mime" TEXT,
    "file_size" INTEGER,
    "irn" TEXT,
    "ack_no" TEXT,
    "ack_date" TIMESTAMPTZ,
    "signed_qr" TEXT,
    "e_invoice_check" TEXT,
    "e_invoice_note" TEXT,
    "ewb_no" TEXT,
    "ewb_valid_until" TIMESTAMPTZ,
    "msme_covered" BOOLEAN NOT NULL DEFAULT false,
    "agreement_basis" TEXT NOT NULL,
    "agreed_days" INTEGER,
    "due_basis" TEXT NOT NULL,
    "acceptance_date" DATE NOT NULL,
    "due_date" DATE,
    "paid_paise" BIGINT NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMPTZ,
    "recorded_by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "paid_on" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_reminders" (
    "invoice_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_reminders_pkey" PRIMARY KEY ("invoice_id","stage")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_order_id_key" ON "purchase_orders"("order_id");

-- CreateIndex
CREATE INDEX "purchase_orders_seller_business_id_created_at_idx" ON "purchase_orders"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_orders_buyer_business_id_created_at_idx" ON "purchase_orders"("buyer_business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_buyer_business_id_number_key" ON "purchase_orders"("buyer_business_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_versions_purchase_order_id_version_key" ON "purchase_order_versions"("purchase_order_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_version_id_line_no_key" ON "purchase_order_lines"("version_id", "line_no");

-- CreateIndex
CREATE INDEX "purchase_order_acks_version_id_created_at_idx" ON "purchase_order_acks"("version_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_irn_key" ON "supplier_invoices"("irn");

-- CreateIndex
CREATE INDEX "supplier_invoices_purchase_order_id_idx" ON "supplier_invoices"("purchase_order_id");

-- CreateIndex
CREATE INDEX "supplier_invoices_buyer_business_id_status_due_date_idx" ON "supplier_invoices"("buyer_business_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "supplier_invoices_msme_covered_status_due_date_idx" ON "supplier_invoices"("msme_covered", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_seller_business_id_financial_year_invoice_key" ON "supplier_invoices"("seller_business_id", "financial_year", "invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_payments_invoice_id_reference_key" ON "supplier_invoice_payments"("invoice_id", "reference");

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_versions" ADD CONSTRAINT "purchase_order_versions_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "purchase_order_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_acks" ADD CONSTRAINT "purchase_order_acks_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "purchase_order_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_payments" ADD CONSTRAINT "supplier_invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_reminders" ADD CONSTRAINT "supplier_invoice_reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

