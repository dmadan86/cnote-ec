-- CreateEnum
CREATE TYPE "approval_action" AS ENUM ('rfq_publish', 'quote_accept', 'order_confirm', 'po_issue');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "approval_decision_kind" AS ENUM ('approved', 'rejected', 'cancelled', 'expired', 'auto_approved');

-- AlterEnum
ALTER TYPE "enquiry_status" ADD VALUE 'pending_approval';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "member_role" ADD VALUE 'admin';
ALTER TYPE "member_role" ADD VALUE 'requester';
ALTER TYPE "member_role" ADD VALUE 'approver';
ALTER TYPE "member_role" ADD VALUE 'finance';
ALTER TYPE "member_role" ADD VALUE 'viewer';

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "action" "approval_action" NOT NULL,
    "min_amount_paise" BIGINT NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policy_levels" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "approver_role" TEXT NOT NULL,
    "approver_person_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "min_amount_paise" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "approval_policy_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "action" "approval_action" NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "subject_summary" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "requester_person_id" UUID NOT NULL,
    "policy_id" UUID,
    "reason" TEXT NOT NULL DEFAULT 'policy',
    "status" "approval_status" NOT NULL DEFAULT 'pending',
    "current_level" INTEGER NOT NULL DEFAULT 1,
    "levels" JSONB NOT NULL,
    "active_key" TEXT,
    "due_at" TIMESTAMPTZ NOT NULL,
    "reminder_count" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "kind" "approval_decision_kind" NOT NULL,
    "decider_person_id" UUID,
    "on_behalf_of_person_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "delegator_person_id" UUID NOT NULL,
    "delegate_person_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_spend_limits" (
    "business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "monthly_cap_paise" BIGINT NOT NULL,
    "updated_by_person_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_spend_limits_pkey" PRIMARY KEY ("business_id","person_id")
);

-- CreateTable
CREATE TABLE "spend_records" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "action" "approval_action" NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spend_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_invites" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "member_role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_person_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "accepted_by_person_id" UUID,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_policies_business_id_action_idx" ON "approval_policies"("business_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policy_levels_policy_id_level_key" ON "approval_policy_levels"("policy_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_active_key_key" ON "approval_requests"("active_key");

-- CreateIndex
CREATE INDEX "approval_requests_business_id_status_created_at_idx" ON "approval_requests"("business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_status_due_at_idx" ON "approval_requests"("status", "due_at");

-- CreateIndex
CREATE INDEX "approval_requests_business_id_subject_type_subject_id_idx" ON "approval_requests"("business_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "approval_requests_requester_person_id_idx" ON "approval_requests"("requester_person_id");

-- CreateIndex
CREATE INDEX "approval_decisions_request_id_created_at_idx" ON "approval_decisions"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_decisions_decider_person_id_idx" ON "approval_decisions"("decider_person_id");

-- CreateIndex
CREATE INDEX "approval_delegations_business_id_delegate_person_id_ends_at_idx" ON "approval_delegations"("business_id", "delegate_person_id", "ends_at");

-- CreateIndex
CREATE INDEX "approval_delegations_delegator_person_id_idx" ON "approval_delegations"("delegator_person_id");

-- CreateIndex
CREATE INDEX "spend_records_business_id_person_id_occurred_at_idx" ON "spend_records"("business_id", "person_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "spend_records_business_id_subject_type_subject_id_key" ON "spend_records"("business_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_invites_token_hash_key" ON "business_invites"("token_hash");

-- CreateIndex
CREATE INDEX "business_invites_business_id_created_at_idx" ON "business_invites"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "business_invites_email_idx" ON "business_invites"("email");

-- AddForeignKey
ALTER TABLE "approval_policy_levels" ADD CONSTRAINT "approval_policy_levels_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "approval_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_invites" ADD CONSTRAINT "business_invites_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- approval_decisions is an append-only audit log (docs/design/buyer-approvals.md; same pattern as security audit M5):
-- no UPDATE ever, except nulling `comment` (DPDP erasure of free text); DELETE/TRUNCATE only inside a retention purge.
-- Raw SQL Prisma cannot model: `prisma migrate diff` never sees triggers, so `pnpm db:new` neither drops nor needs to strip it.
CREATE OR REPLACE FUNCTION cnote_approval_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.comment IS NULL
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
       AND NEW.level IS NOT DISTINCT FROM OLD.level
       AND NEW.kind IS NOT DISTINCT FROM OLD.kind
       AND NEW.decider_person_id IS NOT DISTINCT FROM OLD.decider_person_id
       AND NEW.on_behalf_of_person_id IS NOT DISTINCT FROM OLD.on_behalf_of_person_id
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'append-only table "approval_decisions": only comment may be set to NULL (DPDP erasure)';
  END IF;
  IF NOT cnote_purge_allowed() THEN
    RAISE EXCEPTION 'append-only table "approval_decisions": % is not allowed outside a retention purge (SET LOCAL cnote.allow_purge = ''on'')', TG_OP;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS cnote_append_only ON approval_decisions;
CREATE TRIGGER cnote_append_only BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION cnote_approval_decisions_guard();
DROP TRIGGER IF EXISTS cnote_append_only_truncate ON approval_decisions;
CREATE TRIGGER cnote_append_only_truncate BEFORE TRUNCATE ON approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION cnote_approval_decisions_guard();
