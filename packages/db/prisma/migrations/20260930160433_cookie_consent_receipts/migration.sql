

-- CreateTable
CREATE TABLE "cookie_consent_receipts" (
    "id" UUID NOT NULL,
    "consent_id" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "analytics" BOOLEAN NOT NULL,
    "marketing" BOOLEAN NOT NULL,
    "gpc" BOOLEAN NOT NULL,
    "action" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "person_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cookie_consent_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cookie_consent_receipts_consent_id_created_at_idx" ON "cookie_consent_receipts"("consent_id", "created_at");

-- CreateIndex
CREATE INDEX "cookie_consent_receipts_person_id_created_at_idx" ON "cookie_consent_receipts"("person_id", "created_at");

-- CreateIndex
CREATE INDEX "cookie_consent_receipts_created_at_idx" ON "cookie_consent_receipts"("created_at");

