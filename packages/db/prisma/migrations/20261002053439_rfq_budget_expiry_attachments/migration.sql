

-- AlterTable
ALTER TABLE "enquiries" ADD COLUMN     "budget_max_paise" BIGINT,
ADD COLUMN     "budget_min_paise" BIGINT,
ADD COLUMN     "expires_at" TIMESTAMPTZ,
ADD COLUMN     "min_seller_tier" INTEGER;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "shortlisted_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "enquiry_attachments" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "quote_id" UUID,
    "uploaded_by_business" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiry_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_attachments_key_key" ON "enquiry_attachments"("key");

-- CreateIndex
CREATE INDEX "enquiry_attachments_enquiry_id_idx" ON "enquiry_attachments"("enquiry_id");

-- CreateIndex
CREATE INDEX "enquiry_attachments_quote_id_idx" ON "enquiry_attachments"("quote_id");

-- AddForeignKey
ALTER TABLE "enquiry_attachments" ADD CONSTRAINT "enquiry_attachments_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_attachments" ADD CONSTRAINT "enquiry_attachments_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

