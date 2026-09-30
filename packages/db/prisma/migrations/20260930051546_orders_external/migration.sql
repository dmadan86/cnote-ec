

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "external_buyer_label" TEXT,
ADD COLUMN     "external_ref" TEXT,
ALTER COLUMN "match_id" DROP NOT NULL,
ALTER COLUMN "enquiry_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_ref_key" ON "orders"("external_ref");

