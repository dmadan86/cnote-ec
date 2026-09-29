-- pgvector (already present locally; idempotent)
CREATE EXTENSION IF NOT EXISTS vector;


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "live_listings" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "category_slug" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price_paise" BIGINT,
    "price_unit" TEXT,
    "moq" INTEGER,
    "moq_unit" TEXT,
    "hsn" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "images" JSONB NOT NULL DEFAULT '[]',
    "seller_name" TEXT NOT NULL,
    "seller_city" TEXT,
    "seller_state" TEXT,
    "seller_tier" INTEGER NOT NULL DEFAULT 0,
    "seller_trust_score" INTEGER NOT NULL DEFAULT 0,
    "seller_badge_active" BOOLEAN NOT NULL DEFAULT false,
    "embedding" vector(256),
    "embedding_version" TEXT,
    "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title",'') || ' ' || coalesce("description",''))) STORED,
    "first_published_at" TIMESTAMPTZ NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projection_checkpoints" (
    "consumer" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projection_checkpoints_pkey" PRIMARY KEY ("consumer","key")
);

-- CreateIndex
CREATE INDEX "live_listings_category_id_idx" ON "live_listings"("category_id");

-- CreateIndex
CREATE INDEX "live_listings_seller_business_id_idx" ON "live_listings"("seller_business_id");

-- CreateIndex
CREATE INDEX "live_listings_first_published_at_idx" ON "live_listings"("first_published_at" DESC);

-- CreateIndex
CREATE INDEX "live_listings_search_tsv_idx" ON "live_listings" USING GIN ("search_tsv");

-- CreateIndex
CREATE UNIQUE INDEX "live_categories_slug_key" ON "live_categories"("slug");


-- Raw SQL Prisma cannot model (guarded by scripts/raw-sql-guard.ts)
CREATE INDEX "live_listings_embedding_hnsw_idx" ON "live_listings" USING hnsw ("embedding" vector_cosine_ops);
