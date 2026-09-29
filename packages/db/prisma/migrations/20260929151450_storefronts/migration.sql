-- CreateEnum
CREATE TYPE "storefront_status" AS ENUM ('draft', 'live', 'suspended');

-- CreateEnum
CREATE TYPE "storefront_version_status" AS ENUM ('draft', 'in_review', 'published', 'rejected', 'archived');

-- CreateTable
CREATE TABLE "storefronts" (
    "id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "storefront_status" NOT NULL DEFAULT 'draft',
    "template_key" TEXT,
    "published_version_id" UUID,
    "suspended_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefronts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_versions" (
    "id" UUID NOT NULL,
    "storefront_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "status" "storefront_version_status" NOT NULL DEFAULT 'draft',
    "ai_verdict" TEXT,
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "storefront_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "verticals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "document" JSONB NOT NULL,
    "preview_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_seller_business_id_key" ON "storefronts"("seller_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_slug_key" ON "storefronts"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_published_version_id_key" ON "storefronts"("published_version_id");

-- CreateIndex
CREATE INDEX "storefront_versions_status_created_at_idx" ON "storefront_versions"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_versions_storefront_id_version_key" ON "storefront_versions"("storefront_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_templates_key_key" ON "storefront_templates"("key");

-- AddForeignKey
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "storefront_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_versions" ADD CONSTRAINT "storefront_versions_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

