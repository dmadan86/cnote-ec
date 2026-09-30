

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "refund_reason" TEXT;

-- CreateIndex
CREATE INDEX "matches_enquiry_id_refund_reason_idx" ON "matches"("enquiry_id", "refund_reason");

