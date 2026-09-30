

-- CreateTable
CREATE TABLE "ondc_sellers" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "terms_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ NOT NULL,
    "accepted_by_person_id" UUID,
    "last_published_hash" TEXT,
    "last_published_at" TIMESTAMPTZ,
    "published_items" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ondc_sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ondc_listing_opt_ins" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "ondc_category_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ondc_listing_opt_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ondc_messages" (
    "id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "counterparty_id" TEXT,
    "counterparty_uri" TEXT,
    "status" TEXT NOT NULL,
    "http_status" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ondc_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ondc_orders" (
    "id" UUID NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "bap_id" TEXT NOT NULL,
    "bap_uri" TEXT NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "total_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "items" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "cancel_reason" TEXT,
    "internal_order_id" UUID,
    "received_emitted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ondc_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ondc_sellers_business_id_key" ON "ondc_sellers"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "ondc_listing_opt_ins_listing_id_key" ON "ondc_listing_opt_ins"("listing_id");

-- CreateIndex
CREATE INDEX "ondc_listing_opt_ins_seller_business_id_idx" ON "ondc_listing_opt_ins"("seller_business_id");

-- CreateIndex
CREATE INDEX "ondc_messages_status_created_at_idx" ON "ondc_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "ondc_messages_created_at_idx" ON "ondc_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ondc_messages_direction_action_transaction_id_message_id_key" ON "ondc_messages"("direction", "action", "transaction_id", "message_id");

-- CreateIndex
CREATE INDEX "ondc_orders_seller_business_id_created_at_idx" ON "ondc_orders"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "ondc_orders_transaction_id_idx" ON "ondc_orders"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "ondc_orders_transaction_id_message_id_key" ON "ondc_orders"("transaction_id", "message_id");

