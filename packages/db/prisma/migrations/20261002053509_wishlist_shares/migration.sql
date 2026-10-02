

-- CreateTable
CREATE TABLE "wishlist_shares" (
    "id" UUID NOT NULL,
    "wishlist_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_shares_wishlist_id_key" ON "wishlist_shares"("wishlist_id");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_shares_token_key" ON "wishlist_shares"("token");

-- AddForeignKey
ALTER TABLE "wishlist_shares" ADD CONSTRAINT "wishlist_shares_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "wishlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

