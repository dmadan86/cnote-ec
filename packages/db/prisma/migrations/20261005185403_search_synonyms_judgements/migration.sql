

-- CreateTable
CREATE TABLE "search_synonym_versions" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "groups" JSONB NOT NULL,
    "group_count" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "based_on_version" INTEGER,
    "note" TEXT,
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_synonym_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_judgements" (
    "id" UUID NOT NULL,
    "query_key" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "listing_id" UUID,
    "listing_title" TEXT NOT NULL,
    "category_slug" TEXT,
    "grade" INTEGER NOT NULL,
    "backend" TEXT NOT NULL,
    "judged_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_judgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "search_synonym_versions_version_key" ON "search_synonym_versions"("version");

-- CreateIndex
CREATE INDEX "search_judgements_query_key_idx" ON "search_judgements"("query_key");

-- CreateIndex
CREATE UNIQUE INDEX "search_judgements_query_key_product_key_key" ON "search_judgements"("query_key", "product_key");

