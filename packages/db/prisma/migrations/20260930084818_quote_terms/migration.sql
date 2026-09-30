

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "delivery_charge_paise" BIGINT,
ADD COLUMN     "delivery_note" TEXT,
ADD COLUMN     "delivery_terms" TEXT,
ADD COLUMN     "gst_included" BOOLEAN,
ADD COLUMN     "moq" INTEGER,
ADD COLUMN     "moq_unit" TEXT,
ADD COLUMN     "payment_note" TEXT,
ADD COLUMN     "payment_terms" TEXT;

-- CreateIndex
CREATE INDEX "quotes_seller_business_id_created_at_id_idx" ON "quotes"("seller_business_id", "created_at" DESC, "id" DESC);

