

-- AlterTable
ALTER TABLE "payment_refunds" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "auto_retry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancel_refund_paise" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "cancel_unused_months" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "payment_refunds_status_next_attempt_at_idx" ON "payment_refunds"("status", "next_attempt_at");

