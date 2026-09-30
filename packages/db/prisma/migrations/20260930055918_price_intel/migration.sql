

-- CreateTable
CREATE TABLE "price_benchmarks" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "unit" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "p10_paise" BIGINT NOT NULL,
    "p25_paise" BIGINT NOT NULL,
    "p50_paise" BIGINT NOT NULL,
    "p75_paise" BIGINT NOT NULL,
    "p90_paise" BIGINT NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "quote_count" INTEGER NOT NULL,
    "escrow_count" INTEGER NOT NULL,
    "seller_count" INTEGER NOT NULL,
    "buyer_count" INTEGER NOT NULL,
    "k" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'published',
    "unpublished_reason" TEXT,
    "unpublished_by" UUID,
    "unpublished_at" TIMESTAMPTZ,
    "run_id" UUID,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_benchmark_runs" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "k" INTEGER NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "categories" INTEGER NOT NULL DEFAULT 0,
    "cells" INTEGER NOT NULL DEFAULT 0,
    "suppressedCells" INTEGER NOT NULL DEFAULT 0,
    "suppressed_reasons" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "price_benchmark_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "price_benchmarks_category_id_status_period_idx" ON "price_benchmarks"("category_id", "status", "period");

-- CreateIndex
CREATE UNIQUE INDEX "price_benchmarks_period_category_id_unit_region_tier_key" ON "price_benchmarks"("period", "category_id", "unit", "region", "tier");

-- CreateIndex
CREATE INDEX "price_benchmark_runs_started_at_idx" ON "price_benchmark_runs"("started_at");

