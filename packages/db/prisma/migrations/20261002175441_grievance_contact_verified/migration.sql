-- AlterTable
ALTER TABLE "grievance_tickets" ADD COLUMN     "contact_verified_at" TIMESTAMPTZ;

-- Tickets filed before email verification existed are grandfathered as verified (they are already being worked).
UPDATE "grievance_tickets" SET "contact_verified_at" = "created_at" WHERE "contact_verified_at" IS NULL;
