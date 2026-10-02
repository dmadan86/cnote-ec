

-- CreateTable
CREATE TABLE "lead_refund_reviews" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "refund_rate_bps" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_refund_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_refund_reviews_match_id_key" ON "lead_refund_reviews"("match_id");

-- CreateIndex
CREATE INDEX "lead_refund_reviews_status_created_at_idx" ON "lead_refund_reviews"("status", "created_at");

-- CreateIndex
CREATE INDEX "lead_refund_reviews_seller_business_id_status_idx" ON "lead_refund_reviews"("seller_business_id", "status");

