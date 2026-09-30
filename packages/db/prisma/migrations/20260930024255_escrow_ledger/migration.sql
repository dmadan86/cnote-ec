

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "normal" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_journals" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "escrow_id" UUID,
    "memo" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_lines" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "debit_paise" BIGINT NOT NULL DEFAULT 0,
    "credit_paise" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_agreements" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_business_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "amount_paise" BIGINT NOT NULL,
    "fee_paise" BIGINT NOT NULL,
    "partner" TEXT NOT NULL,
    "partner_ref" TEXT,
    "checkout_url" TEXT,
    "funding_expires_at" TIMESTAMPTZ,
    "funded_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,
    "dispatched_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "auto_release_at" TIMESTAMPTZ,
    "released_paise" BIGINT NOT NULL DEFAULT 0,
    "refunded_paise" BIGINT NOT NULL DEFAULT 0,
    "fee_charged_paise" BIGINT NOT NULL DEFAULT 0,
    "fee_invoice_id" UUID,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_milestones" (
    "id" UUID NOT NULL,
    "escrow_id" UUID NOT NULL,
    "milestone" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_freezes" (
    "id" UUID NOT NULL,
    "escrow_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "escrow_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_payouts" (
    "id" UUID NOT NULL,
    "escrow_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "business_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "partner_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ,
    "settled_at" TIMESTAMPTZ,
    "latency_ms" INTEGER,

    CONSTRAINT "escrow_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" TEXT,
    "processed_at" TIMESTAMPTZ,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_reconciliation_issues" (
    "id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "escrow_id" UUID,
    "kind" TEXT NOT NULL,
    "partner_ref" TEXT,
    "expected_paise" BIGINT,
    "actual_paise" BIGINT,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_by" UUID,
    "resolution_note" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_reconciliation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journals_key_key" ON "ledger_journals"("key");

-- CreateIndex
CREATE INDEX "ledger_journals_escrow_id_idx" ON "ledger_journals"("escrow_id");

-- CreateIndex
CREATE INDEX "ledger_lines_journal_id_idx" ON "ledger_lines"("journal_id");

-- CreateIndex
CREATE INDEX "ledger_lines_account_id_idx" ON "ledger_lines"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_agreements_order_id_key" ON "escrow_agreements"("order_id");

-- CreateIndex
CREATE INDEX "escrow_agreements_buyer_business_id_created_at_idx" ON "escrow_agreements"("buyer_business_id", "created_at");

-- CreateIndex
CREATE INDEX "escrow_agreements_seller_business_id_created_at_idx" ON "escrow_agreements"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "escrow_agreements_status_auto_release_at_idx" ON "escrow_agreements"("status", "auto_release_at");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_milestones_escrow_id_milestone_key" ON "escrow_milestones"("escrow_id", "milestone");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_freezes_dispute_id_key" ON "escrow_freezes"("dispute_id");

-- CreateIndex
CREATE INDEX "escrow_freezes_escrow_id_resolved_at_idx" ON "escrow_freezes"("escrow_id", "resolved_at");

-- CreateIndex
CREATE INDEX "escrow_payouts_status_requested_at_idx" ON "escrow_payouts"("status", "requested_at");

-- CreateIndex
CREATE INDEX "escrow_payouts_escrow_id_idx" ON "escrow_payouts"("escrow_id");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_webhook_events_provider_event_id_key" ON "escrow_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_reconciliation_issues_dedupe_key_key" ON "escrow_reconciliation_issues"("dedupe_key");

-- CreateIndex
CREATE INDEX "escrow_reconciliation_issues_status_created_at_idx" ON "escrow_reconciliation_issues"("status", "created_at");

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "ledger_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_freezes" ADD CONSTRAINT "escrow_freezes_escrow_id_fkey" FOREIGN KEY ("escrow_id") REFERENCES "escrow_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_payouts" ADD CONSTRAINT "escrow_payouts_escrow_id_fkey" FOREIGN KEY ("escrow_id") REFERENCES "escrow_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

