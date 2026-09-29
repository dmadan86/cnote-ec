

-- CreateTable
CREATE TABLE "listing_images" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "alt_text" TEXT,
    "status" "ugc_status" NOT NULL DEFAULT 'pending',
    "moderation_note" TEXT,
    "ai_verdict" TEXT,
    "moderated_by" UUID,
    "moderated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "listing_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "listing_images_storage_key_key" ON "listing_images"("storage_key");

-- CreateIndex
CREATE INDEX "listing_images_listing_id_status_sort_order_idx" ON "listing_images"("listing_id", "status", "sort_order");

-- CreateIndex
CREATE INDEX "listing_images_status_created_at_idx" ON "listing_images"("status", "created_at");

-- CreateIndex
CREATE INDEX "listing_images_listing_id_sha256_idx" ON "listing_images"("listing_id", "sha256");

-- AddForeignKey
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

