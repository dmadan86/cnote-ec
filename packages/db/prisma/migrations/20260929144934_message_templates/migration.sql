-- CreateEnum
CREATE TYPE "template_channel" AS ENUM ('email', 'in_app', 'sms', 'whatsapp');

-- CreateEnum
CREATE TYPE "template_version_status" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "message_layouts" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "published_version_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_layout_versions" (
    "id" UUID NOT NULL,
    "layout_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "header_html" TEXT NOT NULL,
    "footer_html" TEXT NOT NULL,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "status" "template_version_status" NOT NULL DEFAULT 'draft',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "message_layout_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "template_channel" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "layout_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "published_version_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT,
    "preheader" TEXT,
    "body" TEXT NOT NULL,
    "status" "template_version_status" NOT NULL DEFAULT 'draft',
    "change_note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "message_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_assets" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "alt_text" TEXT,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_layouts_key_key" ON "message_layouts"("key");

-- CreateIndex
CREATE UNIQUE INDEX "message_layouts_published_version_id_key" ON "message_layouts"("published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_layout_versions_layout_id_version_key" ON "message_layout_versions"("layout_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_published_version_id_key" ON "message_templates"("published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_key_channel_locale_key" ON "message_templates"("key", "channel", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "message_template_versions_template_id_version_key" ON "message_template_versions"("template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "template_assets_storage_key_key" ON "template_assets"("storage_key");

-- CreateIndex
CREATE INDEX "template_assets_sha256_idx" ON "template_assets"("sha256");

-- AddForeignKey
ALTER TABLE "message_layouts" ADD CONSTRAINT "message_layouts_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "message_layout_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_layout_versions" ADD CONSTRAINT "message_layout_versions_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "message_layouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "message_layouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "message_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_template_versions" ADD CONSTRAINT "message_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

