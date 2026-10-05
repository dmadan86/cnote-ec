-- CreateEnum
CREATE TYPE "availability_status" AS ENUM ('in_stock', 'made_to_order', 'out_of_stock');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "availability" "availability_status" NOT NULL DEFAULT 'in_stock',
ADD COLUMN     "available_qty" INTEGER,
ADD COLUMN     "stock_updated_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "listing_variants" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "axis_values" JSONB NOT NULL,
    "price_paise" BIGINT,
    "price_tiers" JSONB NOT NULL DEFAULT '[]',
    "moq" INTEGER,
    "availability" "availability_status" NOT NULL DEFAULT 'in_stock',
    "available_qty" INTEGER,
    "lead_time_days" INTEGER,
    "stock_updated_at" TIMESTAMPTZ,
    "image_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listing_variants_listing_id_sort_order_idx" ON "listing_variants"("listing_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "listing_variants_listing_id_sku_key" ON "listing_variants"("listing_id", "sku");

-- AddForeignKey
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

