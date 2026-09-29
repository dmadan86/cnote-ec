-- CreateEnum
CREATE TYPE "listing_version_status" AS ENUM ('submitted', 'in_review', 'approved', 'published', 'superseded', 'rejected', 'withdrawn');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "live_version_id" UUID;

-- CreateTable
CREATE TABLE "listing_versions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "change_note" TEXT,
    "status" "listing_version_status" NOT NULL DEFAULT 'submitted',
    "ai_verdict" TEXT,
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "publish_at" TIMESTAMPTZ,
    "published_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listing_versions_status_publish_at_idx" ON "listing_versions"("status", "publish_at");

-- CreateIndex
CREATE UNIQUE INDEX "listing_versions_listing_id_version_key" ON "listing_versions"("listing_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "listings_live_version_id_key" ON "listings"("live_version_id");

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_live_version_id_fkey" FOREIGN KEY ("live_version_id") REFERENCES "listing_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

