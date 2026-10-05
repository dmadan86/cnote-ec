-- AlterTable
ALTER TABLE "live_listings" ADD COLUMN     "availability" TEXT NOT NULL DEFAULT 'in_stock',
ADD COLUMN     "available_qty" INTEGER,
ADD COLUMN     "stock_updated_at" TIMESTAMPTZ,
ADD COLUMN     "variant_axes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "variant_values" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "variants" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "live_listings_availability_idx" ON "live_listings"("availability");

-- CreateIndex
CREATE INDEX "live_listings_variant_values_idx" ON "live_listings" USING GIN ("variant_values");
