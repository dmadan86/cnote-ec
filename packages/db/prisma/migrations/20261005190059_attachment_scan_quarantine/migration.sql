

-- AlterTable
ALTER TABLE "enquiry_attachments" ADD COLUMN     "scanned_at" TIMESTAMPTZ,
ADD COLUMN     "scanner" TEXT;

-- CreateTable
CREATE TABLE "attachment_quarantine" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "uploaded_by_business" UUID NOT NULL,
    "uploaded_by_person" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "scanner" TEXT NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMPTZ,

    CONSTRAINT "attachment_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_quarantine_key_key" ON "attachment_quarantine"("key");

-- CreateIndex
CREATE INDEX "attachment_quarantine_detected_at_idx" ON "attachment_quarantine"("detected_at");

