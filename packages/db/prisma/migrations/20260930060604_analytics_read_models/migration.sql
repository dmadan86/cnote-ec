

-- CreateTable
CREATE TABLE "analytics_checkpoints" (
    "projection" TEXT NOT NULL,
    "last_event_id" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "events_applied" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_checkpoints_pkey" PRIMARY KEY ("projection")
);

-- CreateTable
CREATE TABLE "analytics_refs" (
    "key" TEXT NOT NULL,
    "category_id" TEXT,
    "enquiry_id" TEXT,
    "match_id" TEXT,
    "buyer_business_id" TEXT,
    "seller_business_id" TEXT,
    "state" TEXT,

    CONSTRAINT "analytics_refs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "analytics_funnel_daily" (
    "day" DATE NOT NULL,
    "category_id" TEXT NOT NULL DEFAULT '',
    "enquiries" INTEGER NOT NULL DEFAULT 0,
    "scored" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "declined" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "refunded" INTEGER NOT NULL DEFAULT 0,
    "conversations" INTEGER NOT NULL DEFAULT 0,
    "quotes" INTEGER NOT NULL DEFAULT 0,
    "deals_won" INTEGER NOT NULL DEFAULT 0,
    "deals_lost" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_funnel_daily_pkey" PRIMARY KEY ("day","category_id")
);

-- CreateTable
CREATE TABLE "analytics_gmv_daily" (
    "day" DATE NOT NULL,
    "category_id" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "deals_won" INTEGER NOT NULL DEFAULT 0,
    "reported_gmv_paise" BIGINT NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "order_gmv_paise" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_gmv_daily_pkey" PRIMARY KEY ("day","category_id","state")
);

-- CreateTable
CREATE TABLE "analytics_seller_dim" (
    "business_id" TEXT NOT NULL,
    "cohort_month" DATE NOT NULL,

    CONSTRAINT "analytics_seller_dim_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "analytics_seller_activity" (
    "business_id" TEXT NOT NULL,
    "activity_month" DATE NOT NULL,

    CONSTRAINT "analytics_seller_activity_pkey" PRIMARY KEY ("business_id","activity_month")
);

-- CreateTable
CREATE TABLE "analytics_seller_cohort" (
    "cohort_month" DATE NOT NULL,
    "month_offset" INTEGER NOT NULL,
    "cohort_size" INTEGER NOT NULL DEFAULT 0,
    "active_sellers" INTEGER NOT NULL DEFAULT 0,
    "listings_published" INTEGER NOT NULL DEFAULT 0,
    "leads_accepted" INTEGER NOT NULL DEFAULT 0,
    "quotes_sent" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_seller_cohort_pkey" PRIMARY KEY ("cohort_month","month_offset")
);

-- CreateIndex
CREATE INDEX "analytics_seller_dim_cohort_month_idx" ON "analytics_seller_dim"("cohort_month");

