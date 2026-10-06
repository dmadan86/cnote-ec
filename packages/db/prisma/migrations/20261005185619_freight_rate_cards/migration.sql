

-- CreateTable
CREATE TABLE "freight_rate_cards" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "card" JSONB NOT NULL,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "freight_rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "freight_rate_cards_version_key" ON "freight_rate_cards"("version");

-- CreateIndex
CREATE INDEX "freight_rate_cards_is_active_idx" ON "freight_rate_cards"("is_active");

