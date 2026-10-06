

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "line_gst_paise" BIGINT,
ADD COLUMN     "line_subtotal_paise" BIGINT,
ADD COLUMN     "line_total_paise" BIGINT,
ADD COLUMN     "quoted_line_count" INTEGER;

-- CreateTable
CREATE TABLE "enquiry_lines" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "item_name" TEXT NOT NULL,
    "spec" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "target_price_paise" BIGINT,
    "category_id" UUID,
    "hsn" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "enquiry_line_id" UUID NOT NULL,
    "unit_price_paise" BIGINT,
    "gst_rate_pct" INTEGER,
    "lead_time_days" INTEGER,
    "cant_supply" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "quantity" INTEGER NOT NULL,
    "line_subtotal_paise" BIGINT,
    "line_gst_paise" BIGINT,
    "line_total_paise" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_line_awards" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "enquiry_line_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "quote_line_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "order_id" UUID,
    "ordinal" INTEGER NOT NULL,
    "item_name" TEXT NOT NULL,
    "spec" TEXT,
    "hsn" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "gst_rate_pct" INTEGER,
    "lead_time_days" INTEGER,
    "line_subtotal_paise" BIGINT NOT NULL,
    "line_gst_paise" BIGINT NOT NULL,
    "line_total_paise" BIGINT NOT NULL,
    "gst_included" BOOLEAN,
    "awarded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiry_line_awards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_lines_enquiry_id_ordinal_key" ON "enquiry_lines"("enquiry_id", "ordinal");

-- CreateIndex
CREATE INDEX "quote_lines_enquiry_line_id_idx" ON "quote_lines"("enquiry_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_lines_quote_id_enquiry_line_id_key" ON "quote_lines"("quote_id", "enquiry_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_line_awards_enquiry_line_id_key" ON "enquiry_line_awards"("enquiry_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_line_awards_quote_line_id_key" ON "enquiry_line_awards"("quote_line_id");

-- CreateIndex
CREATE INDEX "enquiry_line_awards_enquiry_id_idx" ON "enquiry_line_awards"("enquiry_id");

-- CreateIndex
CREATE INDEX "enquiry_line_awards_order_id_idx" ON "enquiry_line_awards"("order_id");

-- AddForeignKey
ALTER TABLE "enquiry_lines" ADD CONSTRAINT "enquiry_lines_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_enquiry_line_id_fkey" FOREIGN KEY ("enquiry_line_id") REFERENCES "enquiry_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_line_awards" ADD CONSTRAINT "enquiry_line_awards_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_line_awards" ADD CONSTRAINT "enquiry_line_awards_enquiry_line_id_fkey" FOREIGN KEY ("enquiry_line_id") REFERENCES "enquiry_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_line_awards" ADD CONSTRAINT "enquiry_line_awards_quote_line_id_fkey" FOREIGN KEY ("quote_line_id") REFERENCES "quote_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill (idempotent): every existing enquiry becomes a one-line RFQ. Line 1 = the single-field enquiry
-- (title -> item, requirement -> spec, quantity/unit/target price mirrored; legacy rows without a quantity get 1 "unit").
INSERT INTO "enquiry_lines" ("id", "enquiry_id", "ordinal", "item_name", "spec", "quantity", "unit", "target_price_paise", "category_id", "created_at")
SELECT gen_random_uuid(), e."id", 1, left(e."title", 140), left(e."requirement", 2000), COALESCE(e."quantity", 1), COALESCE(NULLIF(e."quantity_unit", ''), 'unit'), e."target_price_paise", e."category_id", e."created_at"
FROM "enquiries" e
WHERE NOT EXISTS (SELECT 1 FROM "enquiry_lines" l WHERE l."enquiry_id" = e."id");
