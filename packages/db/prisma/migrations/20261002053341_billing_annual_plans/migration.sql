

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "annual_discount_bps" INTEGER NOT NULL DEFAULT 2000;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billing_interval" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "next_grant_at" TIMESTAMPTZ,
ADD COLUMN     "payment_order_id" UUID,
ADD COLUMN     "renewal_reminded_at" TIMESTAMPTZ;

