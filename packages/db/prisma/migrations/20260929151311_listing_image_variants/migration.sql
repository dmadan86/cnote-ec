

-- AlterTable
ALTER TABLE "listing_images" ADD COLUMN     "blur_data_url" TEXT,
ADD COLUMN     "processed_at" TIMESTAMPTZ,
ADD COLUMN     "variants" JSONB NOT NULL DEFAULT '[]';

