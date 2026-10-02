
-- AlterTable
ALTER TABLE "live_listings" ADD COLUMN     "price_tiers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "trade" JSONB NOT NULL DEFAULT '{}';

