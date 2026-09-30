-- CreateEnum
CREATE TYPE "ad_objective" AS ENUM ('enquiries', 'visibility');

-- CreateEnum
CREATE TYPE "ad_campaign_status" AS ENUM ('draft', 'pending_review', 'approved', 'active', 'paused', 'exhausted', 'suspended', 'rejected', 'ended');

-- CreateEnum
CREATE TYPE "ad_review_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ad_keyword_match" AS ENUM ('exact', 'phrase', 'broad');

-- CreateEnum
CREATE TYPE "ad_surface" AS ENUM ('search', 'category', 'product_similar', 'home_rail', 'brand_banner');

-- CreateEnum
CREATE TYPE "ad_click_validity" AS ENUM ('valid', 'pending', 'invalid', 'self_click');

-- CreateEnum
CREATE TYPE "ad_pricing_model" AS ENUM ('rate_card', 'gsp', 'cpm');

-- CreateEnum
CREATE TYPE "ad_wallet_reason" AS ENUM ('topup', 'spend', 'refund_invalid_click', 'promo_credit', 'promo_expire', 'refund_to_source', 'adjustment');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('created', 'pending', 'paid', 'failed', 'refunded', 'partially_refunded');

-- CreateEnum
CREATE TYPE "kyc_status" AS ENUM ('initiated', 'in_progress', 'review', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "promotion_kind" AS ENUM ('hero_banner', 'collection', 'category_spotlight', 'announcement_strip');

-- CreateEnum
CREATE TYPE "promotion_status" AS ENUM ('draft', 'in_review', 'approved', 'archived');

-- CreateEnum
CREATE TYPE "promotion_surface" AS ENUM ('home_hero', 'home_strip', 'home_category_tile', 'home_panel', 'category_top');

-- CreateEnum
CREATE TYPE "offer_kind" AS ENUM ('volume_tiers', 'timed_price', 'free_delivery_moq');

-- CreateEnum
CREATE TYPE "offer_status" AS ENUM ('draft', 'needs_review', 'active', 'rejected', 'expired', 'cancelled', 'suspended');

-- CreateEnum
CREATE TYPE "coupon_kind" AS ENUM ('percent', 'flat', 'extra_credits', 'ad_credit');

-- CreateEnum
CREATE TYPE "coupon_status" AS ENUM ('draft', 'active', 'paused', 'expired', 'exhausted');

-- CreateEnum
CREATE TYPE "coupon_redemption_status" AS ENUM ('reserved', 'applied', 'voided');

-- CreateEnum
CREATE TYPE "referral_status" AS ENUM ('pending', 'qualified', 'rewarded', 'rejected', 'expired');

-- CreateTable
CREATE TABLE "ad_campaigns" (
    "id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" "ad_objective" NOT NULL DEFAULT 'enquiries',
    "status" "ad_campaign_status" NOT NULL DEFAULT 'draft',
    "daily_budget_paise" BIGINT NOT NULL,
    "total_budget_paise" BIGINT,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ,
    "created_by_staff_id" UUID,
    "submitted_at" TIMESTAMPTZ,
    "reviewed_at" TIMESTAMPTZ,
    "reviewed_by" UUID,
    "rejection_reason" TEXT,
    "halt_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_groups" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "surfaces" "ad_surface"[] DEFAULT ARRAY['search', 'category']::"ad_surface"[],
    "max_cpc_paise" BIGINT,
    "category_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pincode_prefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extra_targeting" JSONB NOT NULL DEFAULT '{}',
    "status" "ad_review_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_group_listings" (
    "id" UUID NOT NULL,
    "ad_group_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "reviewStatus" "ad_review_status" NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "ineligible_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_group_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_keywords" (
    "id" UUID NOT NULL,
    "ad_group_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "normalised" TEXT NOT NULL,
    "match_type" "ad_keyword_match" NOT NULL DEFAULT 'phrase',
    "negative" BOOLEAN NOT NULL DEFAULT false,
    "review_status" "ad_review_status" NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_rate_cards" (
    "id" UUID NOT NULL,
    "category_id" UUID,
    "surface" "ad_surface" NOT NULL,
    "pricing_model" "ad_pricing_model" NOT NULL DEFAULT 'rate_card',
    "cpc_paise" BIGINT NOT NULL,
    "max_cpc_paise" BIGINT,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ad_clicks" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "ad_group_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "surface" "ad_surface" NOT NULL,
    "slot" SMALLINT NOT NULL,
    "charged_paise" BIGINT NOT NULL,
    "validity" "ad_click_validity" NOT NULL DEFAULT 'pending',
    "invalid_reason" TEXT,
    "visitor_hash" TEXT NOT NULL,
    "buyer_person_id" UUID,
    "buyer_business_id" UUID,
    "net_hash" TEXT NOT NULL,
    "user_agent_class" TEXT NOT NULL,
    "query_normalised" TEXT,
    "token_id" TEXT NOT NULL,
    "settlement_id" UUID,
    "rescored_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_impression_rollups" (
    "id" UUID NOT NULL,
    "hour" TIMESTAMPTZ NOT NULL,
    "campaign_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "category_id" UUID,
    "surface" "ad_surface" NOT NULL,
    "slot" SMALLINT NOT NULL,
    "served" INTEGER NOT NULL,
    "lost_budget" INTEGER NOT NULL DEFAULT 0,
    "lost_quality" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ad_impression_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_spend_settlements" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "valid_clicks" INTEGER NOT NULL,
    "spend_paise" BIGINT NOT NULL,
    "wallet_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_spend_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_attributions" (
    "id" UUID NOT NULL,
    "click_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "lag_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_review_actions" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "decision" "ad_review_status" NOT NULL,
    "reason_code" TEXT,
    "note" TEXT,
    "staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_review_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_wallet_ledger" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "delta_paise" BIGINT NOT NULL,
    "reason" "ad_wallet_reason" NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "expires_at" TIMESTAMPTZ,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_top_ups" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "gst_paise" BIGINT NOT NULL,
    "gst_rate_bps" INTEGER NOT NULL,
    "sac_code" TEXT NOT NULL,
    "tax_type" TEXT NOT NULL,
    "place_of_supply" TEXT NOT NULL,
    "seller_gstin" TEXT,
    "invoice_number" TEXT NOT NULL,
    "payment_ref" TEXT NOT NULL,
    "wallet_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_top_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "purpose_ref" TEXT,
    "provider" TEXT NOT NULL,
    "provider_order_id" TEXT,
    "provider_payment_id" TEXT,
    "amount_paise" BIGINT NOT NULL,
    "gst_paise" BIGINT NOT NULL,
    "total_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "payment_status" NOT NULL DEFAULT 'created',
    "coupon_code" TEXT,
    "discount_paise" BIGINT NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "fulfilled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID,
    "business_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'tax_invoice',
    "number" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "supplier" JSONB NOT NULL,
    "recipient" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "taxable_paise" BIGINT NOT NULL,
    "cgst_paise" BIGINT NOT NULL DEFAULT 0,
    "sgst_paise" BIGINT NOT NULL DEFAULT 0,
    "igst_paise" BIGINT NOT NULL DEFAULT 0,
    "total_paise" BIGINT NOT NULL,
    "place_of_supply" TEXT NOT NULL,
    "document_key" TEXT,
    "ref_invoice_id" UUID,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "series" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("series")
);

-- CreateTable
CREATE TABLE "payment_refunds" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credit_note_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ,
    "error" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_price_history" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "price_paise" BIGINT,
    "price_unit" TEXT,
    "effective_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reachability_checks" (
    "id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "match_id" UUID,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "token" TEXT NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reachability_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_sessions" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "status" "kyc_status" NOT NULL DEFAULT 'initiated',
    "liveness_score" REAL,
    "face_match_score" REAL,
    "outcome" JSONB NOT NULL DEFAULT '{}',
    "review_note" TEXT,
    "reviewed_by" UUID,
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "storage_key" TEXT,
    "sha256" TEXT NOT NULL,
    "extracted" JSONB NOT NULL DEFAULT '{}',
    "checks" JSONB NOT NULL DEFAULT '{}',
    "verdict" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_audits" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "partner" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "scheduled_for" TIMESTAMPTZ,
    "report_key" TEXT,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "result" TEXT,
    "valid_until" TIMESTAMPTZ,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "kind" "promotion_kind" NOT NULL,
    "template" TEXT NOT NULL,
    "internal_name" TEXT NOT NULL,
    "status" "promotion_status" NOT NULL DEFAULT 'draft',
    "surfaces" "promotion_surface"[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "audience" JSONB NOT NULL DEFAULT '{"segment":"all"}',
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "archived_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_contents" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "subline" TEXT,
    "cta_label" TEXT,
    "cta_href" TEXT,
    "image_key" TEXT,
    "alt_text" TEXT,

    CONSTRAINT "promotion_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_items" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "listing_id" UUID,
    "category_id" UUID,
    "business_id" UUID,
    "position" INTEGER NOT NULL,
    "editor_note" TEXT,

    CONSTRAINT "promotion_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_offers" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "kind" "offer_kind" NOT NULL,
    "status" "offer_status" NOT NULL DEFAULT 'draft',
    "terms" JSONB NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ,
    "reference_price_paise" BIGINT,
    "reference_computed_at" TIMESTAMPTZ,
    "discount_bps" INTEGER,
    "review_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewed_by" UUID,
    "review_note" TEXT,
    "ended_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_honour_reports" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "reported_by_business_id" UUID NOT NULL,
    "enquiry_id" UUID,
    "note" TEXT,
    "upheld" BOOLEAN,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_honour_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "coupon_kind" NOT NULL,
    "status" "coupon_status" NOT NULL DEFAULT 'draft',
    "percent_bps" INTEGER,
    "max_discount_paise" BIGINT,
    "value_paise" BIGINT,
    "extra_credits" INTEGER,
    "plan_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_purchase_only" BOOLEAN NOT NULL DEFAULT true,
    "min_tier" SMALLINT NOT NULL DEFAULT 1,
    "per_business_limit" INTEGER NOT NULL DEFAULT 1,
    "max_redemptions" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_to" TIMESTAMPTZ NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "gstin" TEXT,
    "plan_code" TEXT,
    "discount_paise" BIGINT NOT NULL,
    "credits_granted" INTEGER NOT NULL DEFAULT 0,
    "status" "coupon_redemption_status" NOT NULL DEFAULT 'reserved',
    "checkout_ref" TEXT NOT NULL,
    "subscription_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "referrer_business_id" UUID NOT NULL,
    "referee_business_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "referral_status" NOT NULL DEFAULT 'pending',
    "qualifying_action" TEXT,
    "qualified_at" TIMESTAMPTZ,
    "hold_until" TIMESTAMPTZ,
    "rewarded_at" TIMESTAMPTZ,
    "reward_credits" INTEGER,
    "rejected_reason" TEXT,
    "risk_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_campaigns_seller_business_id_status_idx" ON "ad_campaigns"("seller_business_id", "status");

-- CreateIndex
CREATE INDEX "ad_campaigns_status_starts_at_idx" ON "ad_campaigns"("status", "starts_at");

-- CreateIndex
CREATE INDEX "ad_groups_campaign_id_idx" ON "ad_groups"("campaign_id");

-- CreateIndex
CREATE INDEX "ad_group_listings_listing_id_idx" ON "ad_group_listings"("listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_group_listings_ad_group_id_listing_id_key" ON "ad_group_listings"("ad_group_id", "listing_id");

-- CreateIndex
CREATE INDEX "ad_keywords_normalised_idx" ON "ad_keywords"("normalised");

-- CreateIndex
CREATE UNIQUE INDEX "ad_keywords_ad_group_id_normalised_match_type_negative_key" ON "ad_keywords"("ad_group_id", "normalised", "match_type", "negative");

-- CreateIndex
CREATE INDEX "ad_rate_cards_category_id_surface_effective_from_idx" ON "ad_rate_cards"("category_id", "surface", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "ad_clicks_token_id_key" ON "ad_clicks"("token_id");

-- CreateIndex
CREATE INDEX "ad_clicks_campaign_id_created_at_idx" ON "ad_clicks"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "ad_clicks_validity_created_at_idx" ON "ad_clicks"("validity", "created_at");

-- CreateIndex
CREATE INDEX "ad_clicks_visitor_hash_listing_id_created_at_idx" ON "ad_clicks"("visitor_hash", "listing_id", "created_at");

-- CreateIndex
CREATE INDEX "ad_clicks_net_hash_created_at_idx" ON "ad_clicks"("net_hash", "created_at");

-- CreateIndex
CREATE INDEX "ad_clicks_seller_business_id_created_at_idx" ON "ad_clicks"("seller_business_id", "created_at");

-- CreateIndex
CREATE INDEX "ad_impression_rollups_campaign_id_hour_idx" ON "ad_impression_rollups"("campaign_id", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "ad_impression_rollups_hour_campaign_id_listing_id_surface_s_key" ON "ad_impression_rollups"("hour", "campaign_id", "listing_id", "surface", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_settlements_wallet_entry_id_key" ON "ad_spend_settlements"("wallet_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_settlements_campaign_id_window_start_key" ON "ad_spend_settlements"("campaign_id", "window_start");

-- CreateIndex
CREATE INDEX "ad_attributions_campaign_id_created_at_idx" ON "ad_attributions"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ad_attributions_enquiry_id_key" ON "ad_attributions"("enquiry_id");

-- CreateIndex
CREATE INDEX "ad_review_actions_campaign_id_created_at_idx" ON "ad_review_actions"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ad_wallet_ledger_idempotency_key_key" ON "ad_wallet_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "ad_wallet_ledger_business_id_created_at_idx" ON "ad_wallet_ledger"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "ad_wallet_ledger_business_id_reason_idx" ON "ad_wallet_ledger"("business_id", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "ad_top_ups_invoice_number_key" ON "ad_top_ups"("invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "ad_top_ups_payment_ref_key" ON "ad_top_ups"("payment_ref");

-- CreateIndex
CREATE UNIQUE INDEX "ad_top_ups_wallet_entry_id_key" ON "ad_top_ups"("wallet_entry_id");

-- CreateIndex
CREATE INDEX "ad_top_ups_business_id_created_at_idx" ON "ad_top_ups"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_order_id_key" ON "payment_orders"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_payment_id_key" ON "payment_orders"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payment_orders_business_id_created_at_idx" ON "payment_orders"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_status_created_at_idx" ON "payment_orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_payment_order_id_key" ON "invoices"("payment_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_business_id_issued_at_idx" ON "invoices"("business_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_provider_refund_id_key" ON "payment_refunds"("provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_credit_note_id_key" ON "payment_refunds"("credit_note_id");

-- CreateIndex
CREATE INDEX "payment_refunds_payment_order_id_idx" ON "payment_refunds"("payment_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "listing_price_history_listing_id_effective_from_idx" ON "listing_price_history"("listing_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "reachability_checks_token_key" ON "reachability_checks"("token");

-- CreateIndex
CREATE INDEX "reachability_checks_enquiry_id_idx" ON "reachability_checks"("enquiry_id");

-- CreateIndex
CREATE INDEX "reachability_checks_status_expires_at_idx" ON "reachability_checks"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_sessions_provider_ref_key" ON "kyc_sessions"("provider_ref");

-- CreateIndex
CREATE INDEX "kyc_sessions_business_id_created_at_idx" ON "kyc_sessions"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "kyc_sessions_status_created_at_idx" ON "kyc_sessions"("status", "created_at");

-- CreateIndex
CREATE INDEX "kyc_documents_session_id_idx" ON "kyc_documents"("session_id");

-- CreateIndex
CREATE INDEX "verification_audits_business_id_created_at_idx" ON "verification_audits"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "verification_audits_status_idx" ON "verification_audits"("status");

-- CreateIndex
CREATE INDEX "promotions_status_starts_at_ends_at_idx" ON "promotions"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_contents_promotion_id_locale_key" ON "promotion_contents"("promotion_id", "locale");

-- CreateIndex
CREATE INDEX "promotion_items_promotion_id_position_idx" ON "promotion_items"("promotion_id", "position");

-- CreateIndex
CREATE INDEX "listing_offers_listing_id_status_idx" ON "listing_offers"("listing_id", "status");

-- CreateIndex
CREATE INDEX "listing_offers_seller_business_id_status_idx" ON "listing_offers"("seller_business_id", "status");

-- CreateIndex
CREATE INDEX "listing_offers_status_ends_at_idx" ON "listing_offers"("status", "ends_at");

-- CreateIndex
CREATE INDEX "offer_honour_reports_offer_id_idx" ON "offer_honour_reports"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_status_valid_to_idx" ON "coupons"("status", "valid_to");

-- CreateIndex
CREATE INDEX "coupon_redemptions_coupon_id_status_idx" ON "coupon_redemptions"("coupon_id", "status");

-- CreateIndex
CREATE INDEX "coupon_redemptions_business_id_created_at_idx" ON "coupon_redemptions"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_redemptions_coupon_id_gstin_idx" ON "coupon_redemptions"("coupon_id", "gstin");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_coupon_id_business_id_checkout_ref_key" ON "coupon_redemptions"("coupon_id", "business_id", "checkout_ref");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referee_business_id_key" ON "referrals"("referee_business_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_business_id_status_idx" ON "referrals"("referrer_business_id", "status");

-- CreateIndex
CREATE INDEX "referrals_status_hold_until_idx" ON "referrals"("status", "hold_until");

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_seller_business_id_fkey" FOREIGN KEY ("seller_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_groups" ADD CONSTRAINT "ad_groups_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_group_listings" ADD CONSTRAINT "ad_group_listings_ad_group_id_fkey" FOREIGN KEY ("ad_group_id") REFERENCES "ad_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_group_listings" ADD CONSTRAINT "ad_group_listings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_keywords" ADD CONSTRAINT "ad_keywords_ad_group_id_fkey" FOREIGN KEY ("ad_group_id") REFERENCES "ad_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_clicks" ADD CONSTRAINT "ad_clicks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_clicks" ADD CONSTRAINT "ad_clicks_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "ad_spend_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_spend_settlements" ADD CONSTRAINT "ad_spend_settlements_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_attributions" ADD CONSTRAINT "ad_attributions_click_id_fkey" FOREIGN KEY ("click_id") REFERENCES "ad_clicks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_review_actions" ADD CONSTRAINT "ad_review_actions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_wallet_ledger" ADD CONSTRAINT "ad_wallet_ledger_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_top_ups" ADD CONSTRAINT "ad_top_ups_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_price_history" ADD CONSTRAINT "listing_price_history_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "kyc_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_contents" ADD CONSTRAINT "promotion_contents_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_offers" ADD CONSTRAINT "listing_offers_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_offers" ADD CONSTRAINT "listing_offers_seller_business_id_fkey" FOREIGN KEY ("seller_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_honour_reports" ADD CONSTRAINT "offer_honour_reports_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "listing_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_business_id_fkey" FOREIGN KEY ("referrer_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_business_id_fkey" FOREIGN KEY ("referee_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

