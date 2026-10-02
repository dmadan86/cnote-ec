-- AlterEnum
ALTER TYPE "consent_purpose" ADD VALUE 'functional_cookies';

-- AlterTable
ALTER TABLE "cookie_consent_receipts" ADD COLUMN     "functional" BOOLEAN NOT NULL DEFAULT false;

