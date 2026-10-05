-- CreateEnum
CREATE TYPE "storefront_embed_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "storefront_embed_reviews" (
    "id" UUID NOT NULL,
    "storefront_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "status" "storefront_embed_status" NOT NULL DEFAULT 'pending',
    "title" TEXT,
    "author_name" TEXT,
    "description" TEXT,
    "thumbnail_url" TEXT,
    "ai_verdict" TEXT,
    "ai_decision_id" UUID,
    "decided_by" TEXT,
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "fetch_error" TEXT,
    "checked_at" TIMESTAMPTZ,
    "next_check_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_embed_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storefront_embed_reviews_status_created_at_idx" ON "storefront_embed_reviews"("status", "created_at");

-- CreateIndex
CREATE INDEX "storefront_embed_reviews_status_next_check_at_idx" ON "storefront_embed_reviews"("status", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_embed_reviews_storefront_id_provider_media_id_key" ON "storefront_embed_reviews"("storefront_id", "provider", "media_id");

-- AddForeignKey
ALTER TABLE "storefront_embed_reviews" ADD CONSTRAINT "storefront_embed_reviews_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

