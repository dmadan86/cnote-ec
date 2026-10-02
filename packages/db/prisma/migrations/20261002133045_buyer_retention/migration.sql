

-- CreateTable
CREATE TABLE "supplier_follows" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_searches" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL DEFAULT '',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "sort" TEXT NOT NULL DEFAULT 'relevance',
    "fingerprint" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'off',
    "seen_listing_ids" JSONB NOT NULL DEFAULT '[]',
    "last_run_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_settings" (
    "person_id" UUID NOT NULL,
    "price_drop" BOOLEAN NOT NULL DEFAULT false,
    "back_in_stock" BOOLEAN NOT NULL DEFAULT false,
    "followed_digest" BOOLEAN NOT NULL DEFAULT false,
    "followed_digest_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_settings_pkey" PRIMARY KEY ("person_id")
);

-- CreateTable
CREATE TABLE "alert_dispatches" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_follows_business_id_idx" ON "supplier_follows"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_follows_person_id_business_id_key" ON "supplier_follows"("person_id", "business_id");

-- CreateIndex
CREATE INDEX "saved_searches_person_id_idx" ON "saved_searches"("person_id");

-- CreateIndex
CREATE INDEX "saved_searches_frequency_last_run_at_idx" ON "saved_searches"("frequency", "last_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "saved_searches_person_id_fingerprint_key" ON "saved_searches"("person_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "alert_dispatches_dedupe_key_key" ON "alert_dispatches"("dedupe_key");

-- CreateIndex
CREATE INDEX "alert_dispatches_person_id_idx" ON "alert_dispatches"("person_id");

-- CreateIndex
CREATE INDEX "alert_dispatches_created_at_idx" ON "alert_dispatches"("created_at");

