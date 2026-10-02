

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lead_time_days" INTEGER,
ADD COLUMN     "packaging" TEXT,
ADD COLUMN     "payment_terms" TEXT,
ADD COLUMN     "price_tiers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sample_available" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sample_price_paise" BIGINT,
ADD COLUMN     "supply_capacity_per_month" INTEGER;

