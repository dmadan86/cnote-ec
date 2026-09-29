

-- CreateTable
CREATE TABLE "wishlists" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" UUID NOT NULL,
    "wishlist_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "note" TEXT,
    "saved_price_paise" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wishlists_person_id_idx" ON "wishlists"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "wishlists_person_id_name_key" ON "wishlists"("person_id", "name");

-- CreateIndex
CREATE INDEX "wishlist_items_listing_id_idx" ON "wishlist_items"("listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_items_wishlist_id_listing_id_key" ON "wishlist_items"("wishlist_id", "listing_id");

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "wishlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

