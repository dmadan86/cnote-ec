-- CreateEnum
CREATE TYPE "dispute_type" AS ENUM ('non_delivery', 'quality_mismatch', 'quantity_short', 'damaged', 'wrong_item', 'payment_issue', 'other');

-- CreateEnum
CREATE TYPE "dispute_status" AS ENUM ('open', 'evidence', 'brief_ready', 'auto_resolved', 'awaiting_adjudication', 'resolved', 'withdrawn');

-- CreateEnum
CREATE TYPE "dispute_evidence_kind" AS ENUM ('statement', 'photo', 'document', 'voice', 'system');

-- CreateEnum
CREATE TYPE "dispute_party" AS ENUM ('buyer', 'seller', 'system', 'staff');

-- CreateEnum
CREATE TYPE "dispute_outcome" AS ENUM ('buyer_favour', 'seller_favour', 'split', 'withdrawn');

-- CreateEnum
CREATE TYPE "dispute_appeal_status" AS ENUM ('open', 'upheld', 'modified');

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "opened_by_business_id" UUID NOT NULL,
    "opened_by_person_id" UUID NOT NULL,
    "against_business_id" UUID NOT NULL,
    "opened_by_role" TEXT NOT NULL,
    "type" "dispute_type" NOT NULL,
    "status" "dispute_status" NOT NULL DEFAULT 'open',
    "description" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "amount_paise" BIGINT,
    "at_stake_paise" BIGINT NOT NULL DEFAULT 0,
    "active_order_id" UUID,
    "due_at" TIMESTAMPTZ NOT NULL,
    "response_due_at" TIMESTAMPTZ NOT NULL,
    "counterparty_responded_at" TIMESTAMPTZ,
    "brief_queued_at" TIMESTAMPTZ,
    "brief_ready_at" TIMESTAMPTZ,
    "proposed_outcome" "dispute_outcome",
    "proposed_refund_paise" BIGINT,
    "proposed_release_paise" BIGINT,
    "proposed_fault_business_id" UUID,
    "escalation_deadline" TIMESTAMPTZ,
    "escalated_at" TIMESTAMPTZ,
    "escalated_by_business_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "withdrawn_at" TIMESTAMPTZ,
    "overdue_flagged_at" TIMESTAMPTZ,
    "evidence_purged_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "party" "dispute_party" NOT NULL,
    "submitted_by_business_id" UUID,
    "submitted_by_person_id" UUID,
    "kind" "dispute_evidence_kind" NOT NULL,
    "text" TEXT,
    "media_key" TEXT,
    "mime_type" TEXT,
    "language" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "source_ref" TEXT,
    "purged_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_briefs" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "classified_type" "dispute_type" NOT NULL,
    "summary" TEXT NOT NULL,
    "cited_evidence_ids" JSONB NOT NULL,
    "spec_checks" JSONB NOT NULL,
    "spec_verdict" TEXT NOT NULL,
    "recommended_outcome" "dispute_outcome" NOT NULL,
    "recommended_refund_paise" BIGINT NOT NULL,
    "recommended_release_paise" BIGINT NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "auto_resolvable" BOOLEAN NOT NULL DEFAULT false,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "evidence_count" INTEGER NOT NULL,
    "ai_decision_id" UUID,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_decisions" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "outcome" "dispute_outcome" NOT NULL,
    "refund_paise" BIGINT NOT NULL,
    "release_paise" BIGINT NOT NULL,
    "fault_business_id" UUID,
    "decided_by" TEXT NOT NULL,
    "decided_by_staff_person_id" UUID,
    "brief_id" UUID,
    "followed_recommendation" BOOLEAN NOT NULL DEFAULT false,
    "rationale" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_messages" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "party_business_id" UUID NOT NULL,
    "author_type" "dispute_party" NOT NULL,
    "author_person_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_appeals" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "by_business_id" UUID NOT NULL,
    "by_person_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "dispute_appeal_status" NOT NULL DEFAULT 'open',
    "new_outcome" "dispute_outcome",
    "new_refund_paise" BIGINT,
    "new_release_paise" BIGINT,
    "decided_by_staff_person_id" UUID,
    "resolution_note" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disputes_active_order_id_key" ON "disputes"("active_order_id");

-- CreateIndex
CREATE INDEX "disputes_order_id_idx" ON "disputes"("order_id");

-- CreateIndex
CREATE INDEX "disputes_status_due_at_idx" ON "disputes"("status", "due_at");

-- CreateIndex
CREATE INDEX "disputes_opened_by_business_id_created_at_idx" ON "disputes"("opened_by_business_id", "created_at");

-- CreateIndex
CREATE INDEX "disputes_against_business_id_created_at_idx" ON "disputes"("against_business_id", "created_at");

-- CreateIndex
CREATE INDEX "disputes_resolved_at_idx" ON "disputes"("resolved_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_dispute_id_created_at_idx" ON "dispute_evidence"("dispute_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_evidence_dispute_id_source_ref_key" ON "dispute_evidence"("dispute_id", "source_ref");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_briefs_dispute_id_version_key" ON "dispute_briefs"("dispute_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_decisions_dispute_id_key" ON "dispute_decisions"("dispute_id");

-- CreateIndex
CREATE INDEX "dispute_messages_dispute_id_party_business_id_created_at_idx" ON "dispute_messages"("dispute_id", "party_business_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_appeals_status_created_at_idx" ON "dispute_appeals"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_appeals_dispute_id_by_business_id_key" ON "dispute_appeals"("dispute_id", "by_business_id");

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_briefs" ADD CONSTRAINT "dispute_briefs_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_decisions" ADD CONSTRAINT "dispute_decisions_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_appeals" ADD CONSTRAINT "dispute_appeals_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

