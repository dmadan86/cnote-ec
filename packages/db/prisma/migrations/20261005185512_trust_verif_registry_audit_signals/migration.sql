-- AlterEnum
ALTER TYPE "verification_kind" ADD VALUE 'mca';

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "mca_last_checked_at" TIMESTAMPTZ,
ADD COLUMN     "mca_status" TEXT,
ADD COLUMN     "mca_verified_at" TIMESTAMPTZ,
ADD COLUMN     "udyam_last_checked_at" TIMESTAMPTZ,
ADD COLUMN     "udyam_verified_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "reachability_checks" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "provider_ref" TEXT,
ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'seller_report';

-- AlterTable
ALTER TABLE "verification_audits" ADD COLUMN     "partner_id" UUID,
ADD COLUMN     "re_audit_due_at" TIMESTAMPTZ,
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "reviewed_by" UUID,
ADD COLUMN     "submission" JSONB,
ADD COLUMN     "submitted_at" TIMESTAMPTZ,
ADD COLUMN     "upload_token_expires_at" TIMESTAMPTZ,
ADD COLUMN     "upload_token_hash" TEXT;

-- CreateTable
CREATE TABLE "enquiry_signals" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "ip_hash" TEXT,
    "ua_family" TEXT NOT NULL,
    "velocity_person_1h" INTEGER NOT NULL DEFAULT 0,
    "velocity_person_24h" INTEGER NOT NULL DEFAULT 0,
    "velocity_ip_24h" INTEGER NOT NULL DEFAULT 0,
    "risk_score" SMALLINT NOT NULL,
    "risk_reasons" TEXT[],
    "label" TEXT,
    "labelled_by" UUID,
    "labelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiry_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_partners" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_partners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_signals_enquiry_id_key" ON "enquiry_signals"("enquiry_id");

-- CreateIndex
CREATE INDEX "enquiry_signals_label_created_at_idx" ON "enquiry_signals"("label", "created_at");

-- CreateIndex
CREATE INDEX "enquiry_signals_ip_hash_created_at_idx" ON "enquiry_signals"("ip_hash", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reachability_checks_provider_ref_key" ON "reachability_checks"("provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "verification_audits_upload_token_hash_key" ON "verification_audits"("upload_token_hash");

