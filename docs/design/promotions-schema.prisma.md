# Promotions and Ads: proposed schema, events and privileges

**Status:** Proposal. This is a markdown file on purpose: nothing here is compiled or migrated. When approved, each block moves into the named schema file and `pnpm db:new <name>` generates the migration.
**Design context:** `docs/design/promotions-and-sponsored.md`. **Decisions:** `docs/adr/ADR-024-025-proposed.md`.

Conventions followed (from `_base.prisma`, `billing.prisma`, `catalogue.prisma`, `messaging.prisma`): one schema file per module; models PascalCase with `@@map("snake_plural")`; columns camelCase with `@map("snake_case")`; ids `String @id @default(uuid()) @db.Uuid`; all timestamps `@db.Timestamptz`; money as `BigInt` paise with a `Paise` suffix; enums `@@map`ped to snake_case; append-only ledgers have no `updatedAt` and are never updated or deleted; cross-module relations are declared for referential integrity only (a module queries only its own file's models).

## 0. File map

| File | Owner | Contents |
|---|---|---|
| `ads.prisma` (new) | `@cnote/ads` | Campaigns, ad groups, keywords, clicks, rollups, settlements, attribution, review log, rate card |
| `promotions.prisma` (new) | `@cnote/promotions` | Editorial promotions, seller offers, coupons, referrals |
| `billing.prisma` (additions) | `@cnote/billing` | `AdWalletEntry`, `AdTopUp` |
| `catalogue.prisma` (addition) | `@cnote/catalogue` | `ListingPriceHistory` (prerequisite for honest reference prices) |
| `identity.prisma` (additions) | `@cnote/identity` | back-relations on `Business`; optional `ConsentPurpose.ads_personalisation` (Phase 3), optional `Business.businessType` (Phase 2) |

Back-relations to add on `Business` (identity.prisma), declared for referential integrity only: `adCampaigns AdCampaign[]`, `adWalletEntries AdWalletEntry[]`, `adTopUps AdTopUp[]`, `listingOffers ListingOffer[]`, `couponRedemptions CouponRedemption[]`, `referralsMade Referral[] @relation("Referrer")`, `referralReceived Referral? @relation("Referee")`. On `Listing`: `adGroupListings AdGroupListing[]`, `offers ListingOffer[]`, `priceHistory ListingPriceHistory[]`, `promotionItems PromotionItem[]`.

---

## 1. Schema

### 1.1 `billing.prisma` additions

```prisma
enum AdWalletReason {
  topup               // paid, GST-invoiced (see AdTopUp)
  spend               // settled click spend (one row per campaign per settlement window)
  refund_invalid_click // automatic, no ticket (design 5.6)
  promo_credit        // coupon / campaign credit, expires, non-refundable
  promo_expire
  refund_to_source    // paid balance returned to the payer, with a GST credit note
  adjustment          // finance only, needs billing.adjust and an audit log row

  @@map("ad_wallet_reason")
}

/// Append-only prepaid ad wallet. Balance = sum(delta). Separate from lead credits (CreditLedgerEntry).
/// Integer paise, ex-GST spendable value. Never updated or deleted; a correction is a new row.
model AdWalletEntry {
  id             String         @id @default(uuid()) @db.Uuid
  businessId     String         @map("business_id") @db.Uuid
  /// signed paise: + topup/refund/promo, - spend/expire/refund_to_source
  deltaPaise     BigInt         @map("delta_paise")
  reason         AdWalletReason
  /// "ad_topup" | "ad_settlement" | "ad_click" | "coupon" | "staff"
  refType        String?        @map("ref_type")
  refId          String?        @map("ref_id")
  /// promo credit lots expire (+90 days); paid top-ups never carry an expiry
  expiresAt      DateTime?      @map("expires_at") @db.Timestamptz
  /// idempotency: e.g. "settle:{campaignId}:{windowStart}", "invalid:{clickId}", "topup:{paymentRef}"
  idempotencyKey String         @unique @map("idempotency_key")
  createdAt      DateTime       @default(now()) @map("created_at") @db.Timestamptz

  business Business @relation(fields: [businessId], references: [id])

  @@index([businessId, createdAt])
  @@index([businessId, reason])
  @@map("ad_wallet_ledger")
}

/// A wallet top-up with its GST breakdown. A tax invoice / receipt voucher is issued at top-up
/// (advance for a service). SAC, rate and time-of-supply are to be confirmed by a CA before launch.
model AdTopUp {
  id                String   @id @default(uuid()) @db.Uuid
  businessId        String   @map("business_id") @db.Uuid
  /// ex-GST amount credited to the wallet
  amountPaise       BigInt   @map("amount_paise")
  gstPaise          BigInt   @map("gst_paise")
  gstRateBps        Int      @map("gst_rate_bps") // 1800 = 18%, stored per row so a rate change never rewrites history
  sacCode           String   @map("sac_code")
  /// "CGST_SGST" | "IGST", derived from the seller's state and ours
  taxType           String   @map("tax_type")
  placeOfSupply     String   @map("place_of_supply") // state code
  sellerGstin       String?  @map("seller_gstin")
  invoiceNumber     String   @unique @map("invoice_number")
  /// payment gateway reference (hosted checkout; no card data held) or "manual:{bankRef}" for the pilot
  paymentRef        String   @unique @map("payment_ref")
  walletEntryId     String?  @unique @map("wallet_entry_id") @db.Uuid
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz

  business Business @relation(fields: [businessId], references: [id])

  @@index([businessId, createdAt])
  @@map("ad_top_ups")
}
```

### 1.2 `catalogue.prisma` addition (prerequisite)

```prisma
/// Append-only price history, written whenever Listing.pricePaise changes (and on publish).
/// The promotions module derives the honest "reference price" (lowest price in the preceding 30 days) from it.
model ListingPriceHistory {
  id         String   @id @default(uuid()) @db.Uuid
  listingId  String   @map("listing_id") @db.Uuid
  pricePaise BigInt?  @map("price_paise") // null = price removed / on request
  priceUnit  String?  @map("price_unit")
  effectiveFrom DateTime @default(now()) @map("effective_from") @db.Timestamptz

  listing Listing @relation(fields: [listingId], references: [id])

  @@index([listingId, effectiveFrom])
  @@map("listing_price_history")
}
```

### 1.3 `ads.prisma` (new)

```prisma
// Owned by @cnote/ads. Sponsored placements (ADR-024). Money moves only through @cnote/billing's ad wallet.
// Organic ranking (ADR-009) never reads any model in this file.

enum AdObjective {
  enquiries   // default and only Phase 1.5 objective
  visibility  // Phase 2+

  @@map("ad_objective")
}

enum AdCampaignStatus {
  draft
  pending_review
  approved     // reviewed; serves when scheduled, funded and eligible
  active       // derived/cached state, written by the scheduler job for reporting
  paused       // by the seller
  exhausted    // daily or total budget hit (resumes next IST day for daily)
  suspended    // by staff (ads.suspend)
  rejected
  ended

  @@map("ad_campaign_status")
}

enum AdReviewStatus {
  pending
  approved
  rejected

  @@map("ad_review_status")
}

enum AdKeywordMatch {
  exact
  phrase
  broad

  @@map("ad_keyword_match")
}

enum AdSurface {
  search
  category
  product_similar
  home_rail   // Phase 2
  brand_banner // Phase 3 (creative review)

  @@map("ad_surface")
}

enum AdClickValidity {
  valid
  pending   // real-time rules passed; async re-scoring window (72h) still open
  invalid
  self_click // never charged

  @@map("ad_click_validity")
}

enum AdPricingModel {
  rate_card // Phase 1.5: fixed CPC by category, ranked by relevance x trust
  gsp       // Phase 2: generalized second price
  cpm       // Phase 3: brand banners

  @@map("ad_pricing_model")
}

model AdCampaign {
  id                String           @id @default(uuid()) @db.Uuid
  sellerBusinessId  String           @map("seller_business_id") @db.Uuid
  name              String
  objective         AdObjective      @default(enquiries)
  status            AdCampaignStatus @default(draft)
  dailyBudgetPaise  BigInt           @map("daily_budget_paise") // min Rs 100; IST day; never exceeded
  totalBudgetPaise  BigInt?          @map("total_budget_paise")
  startsAt          DateTime         @map("starts_at") @db.Timestamptz
  endsAt            DateTime?        @map("ends_at") @db.Timestamptz // null = until paused
  /// staff on-behalf creation during the pilot (design phase 1.5b); null = seller-created
  createdByStaffId  String?          @map("created_by_staff_id") @db.Uuid
  submittedAt       DateTime?        @map("submitted_at") @db.Timestamptz
  reviewedAt        DateTime?        @map("reviewed_at") @db.Timestamptz
  reviewedBy        String?          @map("reviewed_by") @db.Uuid // StaffMember id
  rejectionReason   String?          @map("rejection_reason")
  /// why an approved campaign is not serving right now: "wallet" | "eligibility" | "budget" | null
  haltReason        String?          @map("halt_reason")
  createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime         @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  seller      Business           @relation(fields: [sellerBusinessId], references: [id])
  adGroups    AdGroup[]
  clicks      AdClick[]
  settlements AdSpendSettlement[]
  reviews     AdReviewAction[]

  @@index([sellerBusinessId, status])
  @@index([status, startsAt])
  @@map("ad_campaigns")
}

model AdGroup {
  id          String         @id @default(uuid()) @db.Uuid
  campaignId  String         @map("campaign_id") @db.Uuid
  name        String
  surfaces    AdSurface[]    @default([search, category])
  /// Phase 1.5: null (rate card sets the price). Phase 2: seller's max CPC. Never above the category max-CPC cap.
  maxCpcPaise BigInt?        @map("max_cpc_paise")
  /// targeting (all optional; empty = no restriction on that dimension)
  categoryIds String[]       @default([]) @map("category_ids") // Category.id (uuid as text; cross-module, no FK)
  states      String[]       @default([])
  pincodePrefixes String[]   @default([]) @map("pincode_prefixes") // 3-digit prefixes
  /// reserved for Phase 2 buyer-type targeting; validated by zod in code
  extraTargeting Json        @default("{}") @map("extra_targeting")
  status      AdReviewStatus @default(pending)
  createdAt   DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime       @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  campaign AdCampaign        @relation(fields: [campaignId], references: [id])
  listings AdGroupListing[]
  keywords AdKeyword[]

  @@index([campaignId])
  @@map("ad_groups")
}

/// A listing promoted in an ad group. Each row is reviewed independently so one bad listing does not sink a campaign.
model AdGroupListing {
  id            String         @id @default(uuid()) @db.Uuid
  adGroupId     String         @map("ad_group_id") @db.Uuid
  listingId     String         @map("listing_id") @db.Uuid
  reviewStatus  AdReviewStatus @default(pending)
  reviewNote    String?        @map("review_note")
  /// latest eligibility verdict, refreshed by the eligibility sweep; the serving path uses the Redis snapshot
  eligible      Boolean        @default(false)
  ineligibleReason String?     @map("ineligible_reason") // "trust_below_floor" | "listing_unpublished" | "no_approved_image" | ...
  createdAt     DateTime       @default(now()) @map("created_at") @db.Timestamptz

  adGroup AdGroup @relation(fields: [adGroupId], references: [id])
  listing Listing @relation(fields: [listingId], references: [id])

  @@unique([adGroupId, listingId])
  @@index([listingId])
  @@map("ad_group_listings")
}

model AdKeyword {
  id           String         @id @default(uuid()) @db.Uuid
  adGroupId    String         @map("ad_group_id") @db.Uuid
  text         String
  /// normaliseQuery() output (handles transliteration / Hinglish), used for matching
  normalised   String
  matchType    AdKeywordMatch @default(phrase) @map("match_type")
  negative     Boolean        @default(false)
  reviewStatus AdReviewStatus @default(pending) @map("review_status")
  reviewNote   String?        @map("review_note") // "trademark" | "competitor_brand" | "irrelevant" | ...
  createdAt    DateTime       @default(now()) @map("created_at") @db.Timestamptz

  adGroup AdGroup @relation(fields: [adGroupId], references: [id])

  @@unique([adGroupId, normalised, matchType, negative])
  @@index([normalised])
  @@map("ad_keywords")
}

/// Public rate card and auction parameters per category group and surface (staff with ads.settings).
/// Versioned by effectiveFrom so a price change never rewrites what an advertiser was shown or charged.
model AdRateCard {
  id            String         @id @default(uuid()) @db.Uuid
  /// null = platform default; otherwise a Category.id (applies to its subtree)
  categoryId    String?        @map("category_id") @db.Uuid
  surface       AdSurface
  pricingModel  AdPricingModel @default(rate_card) @map("pricing_model")
  /// rate_card: the fixed CPC. gsp: the reserve price.
  cpcPaise      BigInt         @map("cpc_paise")
  maxCpcPaise   BigInt?        @map("max_cpc_paise") // cap so large sellers cannot price out MSMEs
  effectiveFrom DateTime       @map("effective_from") @db.Timestamptz
  createdBy     String?        @map("created_by") @db.Uuid
  createdAt     DateTime       @default(now()) @map("created_at") @db.Timestamptz

  @@index([categoryId, surface, effectiveFrom])
  @@map("ad_rate_cards")
}

/// Runtime knobs as data so staff can change them without a deploy: minRelevance, minTrust, minOrganicForAds,
/// maxAdShare, frequencyCap, attributionWindowDays, invalidClickRescoreHours. Written only by ads.settings.
model AdConfig {
  key       String   @id
  value     Json
  updatedBy String?  @map("updated_by") @db.Uuid
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  @@map("ad_config")
}

/// One row per click. Impressions are NOT stored per row (Redis counters, rolled up hourly below).
model AdClick {
  id             String          @id @default(uuid()) @db.Uuid
  campaignId     String          @map("campaign_id") @db.Uuid
  adGroupId      String          @map("ad_group_id") @db.Uuid
  listingId      String          @map("listing_id") @db.Uuid
  sellerBusinessId String        @map("seller_business_id") @db.Uuid
  surface        AdSurface
  slot           Int             @db.SmallInt // 1-based position within the sponsored placement
  /// price locked at decision time (never above the bid / rate card); charged only when validity = valid
  chargedPaise   BigInt          @map("charged_paise")
  validity       AdClickValidity @default(pending)
  invalidReason  String?         @map("invalid_reason") // "duplicate" | "bot_ua" | "datacenter_asn" | "no_dwell" | "ip_burst" | "self" | ...
  /// pseudonymous first-party id (cnote_vid) hashed with a rotating salt; used only for capping and fraud
  visitorHash    String          @map("visitor_hash")
  buyerPersonId  String?         @map("buyer_person_id") @db.Uuid
  buyerBusinessId String?        @map("buyer_business_id") @db.Uuid
  /// coarse network fingerprint for fraud clustering (IPv4 /24 or IPv6 /48 hash + ASN)
  netHash        String          @map("net_hash")
  userAgentClass String          @map("user_agent_class") // "browser" | "app" | "bot" | "unknown"
  queryNormalised String?        @map("query_normalised")
  /// one-time token id of the signed click URL; unique => replays cannot double-charge
  tokenId        String          @unique @map("token_id")
  settlementId   String?         @map("settlement_id") @db.Uuid
  rescoredAt     DateTime?       @map("rescored_at") @db.Timestamptz
  createdAt      DateTime        @default(now()) @map("created_at") @db.Timestamptz

  campaign   AdCampaign          @relation(fields: [campaignId], references: [id])
  settlement AdSpendSettlement?  @relation(fields: [settlementId], references: [id])
  attributions AdAttribution[]

  @@index([campaignId, createdAt])
  @@index([validity, createdAt])
  @@index([visitorHash, listingId, createdAt])
  @@index([netHash, createdAt])
  @@index([sellerBusinessId, createdAt])
  @@map("ad_clicks")
}

/// Hourly served-impression counts flushed from Redis. Used for CTR, pCTR and lost-impression-share reporting.
model AdImpressionRollup {
  id          String    @id @default(uuid()) @db.Uuid
  hour        DateTime  @db.Timestamptz // truncated to the hour
  campaignId  String    @map("campaign_id") @db.Uuid
  listingId   String    @map("listing_id") @db.Uuid
  categoryId  String?   @map("category_id") @db.Uuid
  surface     AdSurface
  slot        Int       @db.SmallInt
  served      Int
  /// candidate-not-served counts for lost-impression-share (budget vs quality)
  lostBudget  Int       @default(0) @map("lost_budget")
  lostQuality Int       @default(0) @map("lost_quality")

  @@unique([hour, campaignId, listingId, surface, slot])
  @@index([campaignId, hour])
  @@map("ad_impression_rollups")
}

/// One settlement of valid click spend into the wallet per (campaign, window). Idempotent on (campaignId, windowStart).
model AdSpendSettlement {
  id            String    @id @default(uuid()) @db.Uuid
  campaignId    String    @map("campaign_id") @db.Uuid
  sellerBusinessId String @map("seller_business_id") @db.Uuid
  windowStart   DateTime  @map("window_start") @db.Timestamptz
  windowEnd     DateTime  @map("window_end") @db.Timestamptz
  validClicks   Int       @map("valid_clicks")
  spendPaise    BigInt    @map("spend_paise")
  walletEntryId String?   @unique @map("wallet_entry_id") @db.Uuid
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz

  campaign AdCampaign @relation(fields: [campaignId], references: [id])
  clicks   AdClick[]

  @@unique([campaignId, windowStart])
  @@map("ad_spend_settlements")
}

/// Ad-attributed enquiry: an enquiry by the same person/business on that seller's listing within the window after a click.
model AdAttribution {
  id          String   @id @default(uuid()) @db.Uuid
  clickId     String   @map("click_id") @db.Uuid
  enquiryId   String   @map("enquiry_id") @db.Uuid // Enquiry.id (cross-module, no FK)
  campaignId  String   @map("campaign_id") @db.Uuid
  listingId   String   @map("listing_id") @db.Uuid
  lagSeconds  Int      @map("lag_seconds")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  click AdClick @relation(fields: [clickId], references: [id])

  @@unique([enquiryId]) // an enquiry is attributed to at most one click (last click)
  @@index([campaignId, createdAt])
  @@map("ad_attributions")
}

/// Append-only staff review log for campaigns, ad groups, listings and keywords.
model AdReviewAction {
  id          String   @id @default(uuid()) @db.Uuid
  campaignId  String   @map("campaign_id") @db.Uuid
  /// "campaign" | "ad_group" | "listing" | "keyword"
  subjectType String   @map("subject_type")
  subjectId   String   @map("subject_id") @db.Uuid
  decision    AdReviewStatus
  /// reason codes: irrelevant_keyword | trademark | prohibited_category | misleading_listing | low_quality_listing | other
  reasonCode  String?  @map("reason_code")
  note        String?
  staffId     String   @map("staff_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  campaign AdCampaign @relation(fields: [campaignId], references: [id])

  @@index([campaignId, createdAt])
  @@map("ad_review_actions")
}
```

### 1.4 `promotions.prisma` (new)

```prisma
// Owned by @cnote/promotions: editorial promotions, seller offers, coupons, referrals (ADR-025).
// No relation to the ad wallet or invoices: editorial placements are never sold (firewall with @cnote/ads).

enum PromotionKind {
  hero_banner
  collection
  category_spotlight
  announcement_strip

  @@map("promotion_kind")
}

enum PromotionStatus {
  draft
  in_review   // submitted; needs a different staff member with promotions.publish
  approved    // shown while now is inside [startsAt, endsAt)
  archived    // pulled early or ended

  @@map("promotion_status")
}

enum PromotionSurface {
  home_hero
  home_strip
  home_category_tile
  home_panel
  category_top

  @@map("promotion_surface")
}

enum OfferKind {
  volume_tiers
  timed_price
  free_delivery_moq

  @@map("offer_kind")
}

enum OfferStatus {
  draft
  needs_review
  active
  rejected
  expired
  cancelled
  suspended   // staff or listing-change

  @@map("offer_status")
}

enum CouponKind {
  percent
  flat
  extra_credits
  ad_credit   // restricted: super_admin only; spend on ads only, non-refundable, expires

  @@map("coupon_kind")
}

enum CouponStatus {
  draft
  active
  paused
  expired
  exhausted

  @@map("coupon_status")
}

enum CouponRedemptionStatus {
  reserved  // shown at checkout, not yet paid
  applied
  voided    // checkout abandoned or failed

  @@map("coupon_redemption_status")
}

enum ReferralStatus {
  pending    // referee joined, not yet qualified
  qualified  // qualifying action done; 7-day fraud hold running
  rewarded
  rejected
  expired

  @@map("referral_status")
}

/// Editorial, admin-curated, never sold.
model Promotion {
  id           String          @id @default(uuid()) @db.Uuid
  kind         PromotionKind
  /// code-defined layout: "hero_split" | "hero_full_bleed" | "collection_rail" | "category_spotlight" | "strip"
  template     String
  internalName String          @map("internal_name") // staff-facing, e.g. "Diwali gifting 2026"
  status       PromotionStatus @default(draft)
  surfaces     PromotionSurface[]
  priority     Int             @default(0) // higher wins when several are live on a surface
  startsAt     DateTime        @map("starts_at") @db.Timestamptz
  endsAt       DateTime        @map("ends_at") @db.Timestamptz
  /// audience: { segment: "all"|"signed_in"|"buyers"|"sellers", states?: string[], languages?: string[] }
  audience     Json            @default("{\"segment\":\"all\"}")
  createdBy    String          @map("created_by") @db.Uuid // StaffMember id
  approvedBy   String?         @map("approved_by") @db.Uuid // must differ from createdBy (enforced in code)
  approvedAt   DateTime?       @map("approved_at") @db.Timestamptz
  archivedReason String?       @map("archived_reason")
  createdAt    DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime        @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  contents PromotionContent[]
  items    PromotionItem[]

  @@index([status, startsAt, endsAt])
  @@map("promotions")
}

model PromotionContent {
  id           String  @id @default(uuid()) @db.Uuid
  promotionId  String  @map("promotion_id") @db.Uuid
  locale       String  // "en", "hi", ...
  headline     String
  subline      String?
  ctaLabel     String? @map("cta_label")
  ctaHref      String? @map("cta_href") // relative or allow-listed path only
  /// object-storage key via @cnote/media (never a hotlinked URL)
  imageKey     String? @map("image_key")
  altText      String? @map("alt_text") // required whenever imageKey is set (enforced in code)

  promotion Promotion @relation(fields: [promotionId], references: [id])

  @@unique([promotionId, locale])
  @@map("promotion_contents")
}

/// Curated collection members. Chosen on merit by staff; each must pass standard eligibility at render time.
model PromotionItem {
  id            String  @id @default(uuid()) @db.Uuid
  promotionId   String  @map("promotion_id") @db.Uuid
  /// exactly one of the three is set (CHECK constraint added in the raw-SQL migration)
  listingId     String? @map("listing_id") @db.Uuid
  categoryId    String? @map("category_id") @db.Uuid
  businessId    String? @map("business_id") @db.Uuid
  position      Int
  /// curator's reason, kept for audit and for grievance handling
  editorNote    String? @map("editor_note")

  promotion Promotion @relation(fields: [promotionId], references: [id])
  listing   Listing?  @relation(fields: [listingId], references: [id])

  @@index([promotionId, position])
  @@map("promotion_items")
}

model ListingOffer {
  id               String      @id @default(uuid()) @db.Uuid
  listingId        String      @map("listing_id") @db.Uuid
  sellerBusinessId String      @map("seller_business_id") @db.Uuid
  kind             OfferKind
  status           OfferStatus @default(draft)
  /// discriminated by kind; validated by zod:
  ///  volume_tiers:      { tiers: [{ minQty, unitPricePaise }] }               (<= 5 tiers, qty asc, price desc)
  ///  timed_price:       { unitPricePaise }
  ///  free_delivery_moq: { minQty?, minOrderValuePaise?, regions?: string[] }
  terms            Json
  startsAt         DateTime    @map("starts_at") @db.Timestamptz
  endsAt           DateTime?   @map("ends_at") @db.Timestamptz // required for timed_price (max 30 days)
  /// SYSTEM-DERIVED at activation from ListingPriceHistory: lowest price in the 30 days before startsAt.
  /// null when history < 30 days: no strike-through and no percentage is shown.
  referencePricePaise BigInt?  @map("reference_price_paise")
  referenceComputedAt DateTime? @map("reference_computed_at") @db.Timestamptz
  discountBps      Int?        @map("discount_bps") // rounded DOWN from the reference price; null when no reference
  reviewFlags      String[]    @default([]) @map("review_flags") // "deep_discount" | "below_floor" | "prior_honour_complaint"
  reviewedBy       String?     @map("reviewed_by") @db.Uuid
  reviewNote       String?     @map("review_note")
  endedReason      String?     @map("ended_reason") // "expired" | "cancelled" | "listing_changed" | "suspended"
  createdAt        DateTime    @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime    @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  listing Listing        @relation(fields: [listingId], references: [id])
  seller  Business       @relation(fields: [sellerBusinessId], references: [id])
  reports OfferHonourReport[]

  @@index([listingId, status])
  @@index([sellerBusinessId, status])
  @@index([status, endsAt])
  @@map("listing_offers")
}

/// "The seller did not honour this offer". Upheld reports feed the trust score (ADR-003).
model OfferHonourReport {
  id                 String   @id @default(uuid()) @db.Uuid
  offerId            String   @map("offer_id") @db.Uuid
  reportedByBusinessId String @map("reported_by_business_id") @db.Uuid
  enquiryId          String?  @map("enquiry_id") @db.Uuid
  note               String?
  /// null = open; true = upheld against the seller; false = dismissed
  upheld             Boolean?
  decidedBy          String?  @map("decided_by") @db.Uuid
  decidedAt          DateTime? @map("decided_at") @db.Timestamptz
  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz

  offer ListingOffer @relation(fields: [offerId], references: [id])

  @@index([offerId])
  @@map("offer_honour_reports")
}

model Coupon {
  id                String       @id @default(uuid()) @db.Uuid
  /// stored upper-case, unique; random 10+ chars for targeted codes
  code              String       @unique
  name              String
  kind              CouponKind
  status            CouponStatus @default(draft)
  percentBps        Int?         @map("percent_bps")       // percent kind
  maxDiscountPaise  BigInt?      @map("max_discount_paise")
  valuePaise        BigInt?      @map("value_paise")       // flat / ad_credit
  extraCredits      Int?         @map("extra_credits")     // extra_credits kind
  /// plan codes it applies to; empty = all paid plans
  planCodes         String[]     @default([]) @map("plan_codes")
  firstPurchaseOnly Boolean      @default(true) @map("first_purchase_only")
  minTier           Int          @default(1) @map("min_tier") @db.SmallInt // verification tier required
  perBusinessLimit  Int          @default(1) @map("per_business_limit")
  maxRedemptions    Int?         @map("max_redemptions")
  redeemedCount     Int          @default(0) @map("redeemed_count") // maintained in the redeem tx (SELECT ... FOR UPDATE)
  /// coupons never stack with each other (one per checkout); kept explicit for future policy
  stackable         Boolean      @default(false)
  validFrom         DateTime     @map("valid_from") @db.Timestamptz
  validTo           DateTime     @map("valid_to") @db.Timestamptz
  createdBy         String       @map("created_by") @db.Uuid
  /// second approver for large values (design 6.3)
  approvedBy        String?      @map("approved_by") @db.Uuid
  createdAt         DateTime     @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime     @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  redemptions CouponRedemption[]

  @@index([status, validTo])
  @@map("coupons")
}

/// Append-only in spirit: status moves reserved -> applied | voided; amounts are never edited.
model CouponRedemption {
  id             String                 @id @default(uuid()) @db.Uuid
  couponId       String                 @map("coupon_id") @db.Uuid
  businessId     String                 @map("business_id") @db.Uuid
  gstin          String?                // snapshot, for the one-per-GSTIN rule
  planCode       String?                @map("plan_code")
  discountPaise  BigInt                 @map("discount_paise")
  creditsGranted Int                    @default(0) @map("credits_granted")
  status         CouponRedemptionStatus @default(reserved)
  /// checkout reference; unique per (coupon, business) so a retry is idempotent
  checkoutRef    String                 @map("checkout_ref")
  subscriptionId String?                @map("subscription_id") @db.Uuid
  createdAt      DateTime               @default(now()) @map("created_at") @db.Timestamptz
  appliedAt      DateTime?              @map("applied_at") @db.Timestamptz

  coupon   Coupon   @relation(fields: [couponId], references: [id])
  business Business @relation(fields: [businessId], references: [id])

  @@unique([couponId, businessId, checkoutRef])
  @@index([couponId, status])
  @@index([businessId, createdAt])
  @@index([couponId, gstin])
  @@map("coupon_redemptions")
}

model Referral {
  id                 String         @id @default(uuid()) @db.Uuid
  referrerBusinessId String         @map("referrer_business_id") @db.Uuid
  /// one referrer per referee
  refereeBusinessId  String         @unique @map("referee_business_id") @db.Uuid
  code               String         // referrer's public code
  status             ReferralStatus @default(pending)
  /// "listing_published" | "first_verified_enquiry"
  qualifyingAction   String?        @map("qualifying_action")
  qualifiedAt        DateTime?      @map("qualified_at") @db.Timestamptz
  holdUntil          DateTime?      @map("hold_until") @db.Timestamptz // 7-day fraud hold after qualification
  rewardedAt         DateTime?      @map("rewarded_at") @db.Timestamptz
  rewardCredits      Int?           @map("reward_credits") // per side; granted via billing.grantCredits (refType "referral")
  rejectedReason     String?        @map("rejected_reason") // shown to the referrer; no silent denial
  /// fraud signals captured at signup: shared gstin/phone/device/ip cluster flags
  riskFlags          String[]       @default([]) @map("risk_flags")
  createdAt          DateTime       @default(now()) @map("created_at") @db.Timestamptz

  referrer Business  @relation("Referrer", fields: [referrerBusinessId], references: [id])
  referee  Business  @relation("Referee", fields: [refereeBusinessId], references: [id])

  @@index([referrerBusinessId, status])
  @@index([status, holdUntil])
  @@map("referrals")
}
```

**Raw-SQL migration notes** (Prisma cannot express these; add by hand and cover in `db:check` if it lists extras):
- `promotion_items`: `CHECK (num_nonnulls(listing_id, category_id, business_id) = 1)`.
- `promotions`: `CHECK (ends_at > starts_at)`; `listing_offers`: `CHECK (ends_at IS NULL OR ends_at > starts_at)`; `ad_campaigns`: `CHECK (daily_budget_paise >= 10000)`.
- `ad_wallet_ledger` and `ad_clicks`: revoke `UPDATE`/`DELETE` for the app role on `ad_wallet_ledger`; on `ad_clicks` only `validity`, `invalid_reason`, `settlement_id`, `rescored_at` may change (a trigger or column-level grants).
- Partial index for hot lookups: `CREATE INDEX ... ON listing_offers (listing_id) WHERE status = 'active'`.

---

## 2. Ad wallet invariants

- Balance = `SUM(delta_paise)` over non-expired lots; spend draws promo lots first (earliest expiry), then paid balance.
- Spend never exceeds the balance: the settlement job reads the balance under the same transaction lock pattern billing already uses (`lockBusiness`), and clips to the balance; unbilled clicks past that point are marked `charged_paise = 0`.
- Every write has an `idempotency_key`. Settlement is `settle:{campaignId}:{windowStart}`; invalid-click refund is `invalid:{clickId}`; top-up is `topup:{paymentRef}`.
- A paid top-up refund is a `refund_to_source` row plus a GST credit note; promo credit is never refunded.

---

## 3. Domain event catalogue additions

Add to `packages/core/src/events/catalog.ts` (payload type map) and to the version map (`1` for each). Money is `number` paise at the event boundary, consistent with existing events. Handlers must be idempotent.

```ts
// ── ads ──────────────────────────────────────────────────────────────────────────
AdCampaignSubmitted:     { campaignId: string; sellerBusinessId: string; objective: "enquiries" | "visibility"; dailyBudgetPaise: number; createdByStaff: boolean };
AdCampaignReviewed:      { campaignId: string; sellerBusinessId: string; decision: "approved" | "rejected"; reviewedBy: string; reasonCode?: string; note?: string };
AdCampaignStatusChanged: { campaignId: string; sellerBusinessId: string; from: string; to: string; cause: "seller" | "staff" | "budget" | "wallet" | "eligibility" | "schedule" };
AdBudgetExhausted:       { campaignId: string; sellerBusinessId: string; istDate: string; spentPaise: number; dailyBudgetPaise: number };
AdIneligible:            { listingId: string; sellerBusinessId: string; campaignId: string; reason: string }; // trust_below_floor | listing_unpublished | no_approved_image | category_prohibited | ...
AdWalletToppedUp:        { businessId: string; topUpId: string; amountPaise: number; gstPaise: number; invoiceNumber: string };
AdWalletLow:             { businessId: string; balancePaise: number; thresholdPaise: number };
AdClicked:               { clickId: string; campaignId: string; adGroupId: string; listingId: string; sellerBusinessId: string; surface: string; slot: number; chargedPaise: number; validity: "valid" | "pending" | "invalid" | "self_click"; invalidReason?: string };
AdClickInvalidated:      { clickId: string; campaignId: string; sellerBusinessId: string; reason: string; refundedPaise: number; source: "rules" | "rescore" | "staff" };
AdSpendSettled:          { settlementId: string; campaignId: string; sellerBusinessId: string; windowStart: string; windowEnd: string; validClicks: number; spendPaise: number };
AdImpressionsRolledUp:   { hour: string; campaignId: string; surface: string; served: number; lostBudget: number; lostQuality: number }; // one per campaign per surface per hour, not per impression
AdAttributionRecorded:   { attributionId: string; clickId: string; campaignId: string; listingId: string; enquiryId: string; lagSeconds: number };

// ── promotions ───────────────────────────────────────────────────────────────────
PromotionPublished:      { promotionId: string; kind: string; surfaces: string[]; startsAt: string; endsAt: string; createdBy: string; approvedBy: string };
PromotionArchived:       { promotionId: string; reason: string; archivedBy: string };
OfferCreated:            { offerId: string; listingId: string; sellerBusinessId: string; kind: "volume_tiers" | "timed_price" | "free_delivery_moq"; needsReview: boolean };
OfferActivated:          { offerId: string; listingId: string; sellerBusinessId: string; referencePricePaise: number | null; discountBps: number | null; startsAt: string; endsAt: string | null };
OfferRejected:           { offerId: string; listingId: string; sellerBusinessId: string; reason: string; reviewedBy?: string };
OfferEnded:              { offerId: string; listingId: string; sellerBusinessId: string; reason: "expired" | "cancelled" | "listing_changed" | "suspended" };
OfferHonourReported:     { reportId: string; offerId: string; sellerBusinessId: string; reportedByBusinessId: string };
OfferHonourDecided:      { reportId: string; offerId: string; sellerBusinessId: string; upheld: boolean };
CouponRedeemed:          { couponId: string; redemptionId: string; businessId: string; planCode: string | null; discountPaise: number; creditsGranted: number };
CouponVoided:            { couponId: string; redemptionId: string; businessId: string; reason: string };
ReferralQualified:       { referralId: string; referrerBusinessId: string; refereeBusinessId: string; action: "listing_published" | "first_verified_enquiry"; holdUntil: string };
ReferralRewarded:        { referralId: string; referrerBusinessId: string; refereeBusinessId: string; creditsEach: number };
ReferralRejected:        { referralId: string; referrerBusinessId: string; refereeBusinessId: string; reason: string };
```

**Consumers**
| Event | Consumer | Effect |
|---|---|---|
| `ListingModerated`, `ListingImageModerated`, `ListingArchived`, `TrustScoreChanged` (existing) | ads worker | rebuild eligibility snapshot; emit `AdIneligible`, pause serving |
| `AdCampaign*`, `AdBudgetExhausted`, `AdWalletLow`, `AdIneligible`, `AdClickInvalidated`, offer and referral events | notifications | in-app plus email (template keys in design 7.3) |
| `TrustScoreChanged` input from `OfferHonourDecided(upheld=true)` | identity | small negative trust signal (weight is a tuning item, ADR-003 Appendix C.7) |
| `ListingPublished`, `BusinessVerified` (existing) | promotions worker | referral qualification check |
| `LeadAccepted` (existing) | promotions worker | referral qualification for buyer-side action (first verified enquiry) |

Optional payload bump (versioned, not edited): `EnquiryCreated` v2 with `listingId?: string` and `adClickId?: string`, so attribution can be audited from the event log alone.

---

## 4. Admin privileges (add to `PRIVILEGES` in `packages/admin/src/rbac.ts`)

```ts
"ads.read",           // view campaigns, reports, review queue, rate card
"ads.review",         // approve/reject campaigns, ad groups, listings and keywords
"ads.suspend",        // suspend a campaign or a business's ads immediately (kill switch)
"ads.fraud.review",   // adjudicate invalid-traffic flags; bulk invalidate and refund
"ads.settings",       // rate card, caps, thresholds (super_admin only)
"promotions.read",    // view editorial promotions and their schedule
"promotions.manage",  // draft/edit promotions and upload creative
"promotions.publish", // approve/archive a promotion; must differ from the author
"offers.review",      // review seller offers held for flags; decide honour reports
"coupons.read",       // view coupons and redemptions
"coupons.manage",     // create/pause coupons (large values need a second approver; ad_credit is super_admin only)
"referrals.review",   // review flagged referrals and release or reject rewards
```

**Role mapping**

| Role | Adds |
|---|---|
| `super_admin` | all (via `PRIVILEGES`) |
| `ops_moderator` | `ads.read`, `ads.review`, `ads.suspend`, `ads.fraud.review`, `offers.review`, `promotions.read` |
| `marketing` | `promotions.read`, `promotions.manage`, `promotions.publish`, `coupons.read`, `coupons.manage`, `ads.read` |
| `finance` | `ads.read`, `ads.fraud.review`, `coupons.read` (plus existing `billing.adjust` for wallet corrections) |
| `support` | `ads.read`, `promotions.read`, `coupons.read`, `referrals.review` |
| `viewer` | none (ads data includes advertiser spend; keep it out of the read-only role) |

Guards enforced in code, not only by privilege: promotion `approvedBy != createdBy`; coupon `approvedBy != createdBy` above the value threshold; `ad_credit` coupons and `ads.settings` changes require `super_admin`; every mutation goes through `audited()` (which writes `AdminAuditLog`).
