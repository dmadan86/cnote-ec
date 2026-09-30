

-- AlterTable
ALTER TABLE "escrow_payouts" ADD COLUMN     "assignment_ref" TEXT,
ADD COLUMN     "beneficiary_ref" TEXT;

-- CreateTable
CREATE TABLE "escrow_lender_assignments" (
    "escrow_id" UUID NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "partner" TEXT NOT NULL,
    "partner_loan_ref" TEXT NOT NULL,
    "due_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_lender_assignments_pkey" PRIMARY KEY ("escrow_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "escrow_lender_assignments_assignment_id_key" ON "escrow_lender_assignments"("assignment_id");

