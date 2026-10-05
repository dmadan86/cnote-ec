

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "expiry_notice_7d_at" TIMESTAMPTZ,
ADD COLUMN     "expiry_notice_day_at" TIMESTAMPTZ;

