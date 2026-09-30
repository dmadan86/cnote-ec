-- CreateEnum
CREATE TYPE "vertical_stage" AS ENUM ('candidate', 'pilot', 'open', 'paused');

-- CreateEnum
CREATE TYPE "vertical_checklist_section" AS ENUM ('schema', 'classifiers', 'acquisition', 'languages', 'ops', 'compliance');

-- CreateTable
CREATE TABLE "verticals" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "vertical_stage" NOT NULL DEFAULT 'candidate',
    "category_slugs" TEXT[],
    "languages" TEXT[],
    "clusters" JSONB NOT NULL DEFAULT '[]',
    "gates" JSONB NOT NULL DEFAULT '{}',
    "classifier_config" JSONB NOT NULL DEFAULT '{}',
    "attribute_schema_slug" TEXT,
    "notes" TEXT,
    "stage_changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verticals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vertical_checklist_items" (
    "id" UUID NOT NULL,
    "vertical_id" UUID NOT NULL,
    "section" "vertical_checklist_section" NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "owner" TEXT,
    "evidence_url" TEXT,
    "done_at" TIMESTAMPTZ,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vertical_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vertical_stage_changes" (
    "id" UUID NOT NULL,
    "vertical_id" UUID NOT NULL,
    "from_stage" "vertical_stage" NOT NULL,
    "to_stage" "vertical_stage" NOT NULL,
    "changed_by" TEXT NOT NULL,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "gate_snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vertical_stage_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vertical_metric_snapshots" (
    "id" UUID NOT NULL,
    "vertical_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "verified_sellers" INTEGER NOT NULL,
    "net_adds_30" INTEGER,
    "net_adds_90" INTEGER,
    "meets_gates" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vertical_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verticals_slug_key" ON "verticals"("slug");

-- CreateIndex
CREATE INDEX "verticals_stage_idx" ON "verticals"("stage");

-- CreateIndex
CREATE INDEX "vertical_checklist_items_vertical_id_section_sort_order_idx" ON "vertical_checklist_items"("vertical_id", "section", "sort_order");

-- CreateIndex
CREATE INDEX "vertical_stage_changes_vertical_id_created_at_idx" ON "vertical_stage_changes"("vertical_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vertical_metric_snapshots_vertical_id_day_key" ON "vertical_metric_snapshots"("vertical_id", "day");

-- AddForeignKey
ALTER TABLE "vertical_checklist_items" ADD CONSTRAINT "vertical_checklist_items_vertical_id_fkey" FOREIGN KEY ("vertical_id") REFERENCES "verticals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vertical_stage_changes" ADD CONSTRAINT "vertical_stage_changes_vertical_id_fkey" FOREIGN KEY ("vertical_id") REFERENCES "verticals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vertical_metric_snapshots" ADD CONSTRAINT "vertical_metric_snapshots_vertical_id_fkey" FOREIGN KEY ("vertical_id") REFERENCES "verticals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

