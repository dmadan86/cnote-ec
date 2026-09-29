-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('queued', 'sending', 'sent', 'failed', 'suppressed');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "business_id" UUID,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_usage_daily" (
    "api_key_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "mcp_calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "api_key_usage_daily_pkey" PRIMARY KEY ("api_key_id","day")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "to_person_id" UUID,
    "to_masked" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'queued',
    "provider" TEXT,
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "business_id" UUID,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "app" TEXT NOT NULL,
    "source_event_id" BIGINT,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "person_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "sms" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("person_id","category")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "api_keys_person_id_revoked_at_idx" ON "api_keys"("person_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_dedupe_key_key" ON "email_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "email_messages_to_person_id_created_at_idx" ON "email_messages"("to_person_id", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_status_created_at_idx" ON "email_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "notifications_person_id_app_read_at_created_at_idx" ON "notifications"("person_id", "app", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_person_id_kind_source_event_id_key" ON "notifications"("person_id", "kind", "source_event_id");

-- AddForeignKey
ALTER TABLE "api_key_usage_daily" ADD CONSTRAINT "api_key_usage_daily_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

