

-- AlterTable
ALTER TABLE "payment_refunds" ADD COLUMN     "last_polled_at" TIMESTAMPTZ,
ADD COLUMN     "next_poll_at" TIMESTAMPTZ,
ADD COLUMN     "poll_attempts" INTEGER NOT NULL DEFAULT 0;

