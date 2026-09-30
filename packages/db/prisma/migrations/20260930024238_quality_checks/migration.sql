-- CreateEnum
CREATE TYPE "quality_status" AS ENUM ('pending', 'analysing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "quality_outcome" AS ENUM ('consistent', 'inconsistent', 'inconclusive');

-- CreateTable
CREATE TABLE "quality_checks" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "submitted_by_person_id" UUID NOT NULL,
    "category_slug" TEXT NOT NULL,
    "status" "quality_status" NOT NULL DEFAULT 'pending',
    "verdict" "quality_outcome",
    "confidence" DOUBLE PRECISION,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "prompt_version" TEXT,
    "model_id" TEXT,
    "decision_id" UUID,
    "expected_spec" JSONB NOT NULL DEFAULT '{}',
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_check_media" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMPTZ,

    CONSTRAINT "quality_check_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_check_results" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "check" TEXT NOT NULL,
    "result" "quality_outcome" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_check_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_labels" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "check" TEXT NOT NULL,
    "category_slug" TEXT NOT NULL,
    "label" "quality_outcome" NOT NULL,
    "labelled_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_categories" (
    "category_slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "accuracy_at_enable" DOUBLE PRECISION,
    "labels_at_enable" INTEGER,
    "pilot" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_categories_pkey" PRIMARY KEY ("category_slug")
);

-- CreateIndex
CREATE INDEX "quality_checks_order_id_created_at_idx" ON "quality_checks"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "quality_checks_status_created_at_idx" ON "quality_checks"("status", "created_at");

-- CreateIndex
CREATE INDEX "quality_checks_category_slug_status_idx" ON "quality_checks"("category_slug", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quality_check_media_key_key" ON "quality_check_media"("key");

-- CreateIndex
CREATE INDEX "quality_check_media_created_at_idx" ON "quality_check_media"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quality_check_media_check_id_sha256_key" ON "quality_check_media"("check_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "quality_check_results_check_id_check_key" ON "quality_check_results"("check_id", "check");

-- CreateIndex
CREATE UNIQUE INDEX "quality_labels_result_id_key" ON "quality_labels"("result_id");

-- CreateIndex
CREATE INDEX "quality_labels_category_slug_idx" ON "quality_labels"("category_slug");

