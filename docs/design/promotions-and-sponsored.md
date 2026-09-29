# Promotions and Sponsored Products: design

**Status:** Proposal for founder review. No code or schema has been changed. Companion files: `docs/design/promotions-schema.prisma.md` (models, events, privileges) and `docs/adr/ADR-024-025-proposed.md` (decisions to ratify).
**Related ADRs:** 000 (trust is the product), 002 (capped exclusive leads), 003 (trust score), 005 (transparent pricing, "ranking boost tied to trust score, not payment"), 007 (event log), 009 (rank by relevance x trust, sponsored labelled), 010 (compliance), 022 (price intelligence).
**Dated:** 29 Sep 2026.

---

## 1. Summary of decisions

1. **Organic ranking is never bought.** Nothing in this document adds a paid input to `rrfFuse x trustFactor x locationBoost` in `packages/search`. Ads live in separate, labelled, capped slots.
2. **Sponsored Products ship in two steps.** Phase 1.5: a public rate card (fixed CPC per category), manual approval, slots ranked by relevance x trust among eligible advertisers, no bidding. Phase 2: GSP auction with `bid x quality` where quality = relevance x trust x predicted CTR.
3. **Editorial promotions and paid ads are separate systems with a firewall.** Admin-curated banners and collections (`promotions`) can never be sold. Anything a seller pays for is an ad (`ads`) and carries the "Sponsored" label.
4. **Seller offers use system-derived reference prices.** A strike-through is shown only against the lowest price in the prior 30 days, computed by us from price history, never typed by the seller.
5. **Money.** A prepaid ad wallet in paise, separate from lead credits, owned by `billing` as an append-only ledger. Spend is settled in batches. Invalid clicks are refunded automatically with no ticket, matching ADR-002's refund philosophy.
6. **Ship the disclosure first.** The ranking-parameters page and the "Sponsored" component ship before the first paid slot.

---

## 2. Research: what others do (and what went wrong)

Sources are linked. Where a source is a vendor or agency blog rather than the platform itself, that is stated. No figures below are our own estimates.

### 2.1 Marketplaces

| Platform | What they do | What we take / avoid |
|---|---|---|
| **Amazon Sponsored Products** | Second-price auction; the ad is scored on bid together with relevance, expected CTR and listing quality and past performance, so a high-converting listing can beat a higher bid. Ads look like organic cards with a small "Sponsored" label. ([42signals](https://www.42signals.com/blog/amazon-sponsored-products-pricing-intelligence-roi/), [Ad Badger](https://www.adbadger.com/blog/amazon-advertising-what-does-sponsored-mean-on-amazon/)) | Take: quality-weighted GSP, ad = the listing card. Avoid: near-invisible label. Critics note Amazon separates sponsored groups with a very thin grey border and a single label, and that sponsored items sometimes appear above identical cheaper unsponsored ones ([KOMO summary of FTC allegations](https://komonews.com/news/consumer/amazon-search-results-overrun-ads-ftc-lawsuit-alleges-monopolistic-behavior-federal-trade-commission-shopping-consumer-brands-retail-delivery-paid-promo-products-promotion-e-commerce-research-study)). |
| **Amazon: advertiser-side trust** | In Aug 2026 the FTC and states sued Amazon alleging undisclosed surcharges on advertisers in ad auctions ([FTC press release](https://www.ftc.gov/news-events/news/press-releases/2026/08/ftc-states-sue-amazon-over-secret-ad-surcharge-scheme), [CNBC](https://www.cnbc.com/2026/08/31/amazon-ftc-lawsuit-advertisers.html)). These are allegations, not findings. | Take: advertisers must be able to reproduce what they were charged. Publish the pricing rule; never charge more than the bid. |
| **Alibaba.com P4P / keyword advertising** | CPC keyword auction; promotion score and keyword star rating decide rank; low-score promotions are not accepted ([XTransfer](https://www.xtransfer.com/archives/666a88271b516f4336881e46), [Wikipedia: pay for performance advertising](https://en.wikipedia.org/wiki/Pay_for_performance_advertising)). Suppliers can pay for higher placement in regular search results. ([MIT Tech Review on Accio](https://www.technologyreview.com/2026/04/06/1135118/ai-online-seller-alibaba-accio/)) | Take: minimum quality score to enter at all. Avoid: paid placement inside the organic list. |
| **IndiaMART** | TrustSEAL is available only to paid subscribers; verified suppliers get higher placement and a larger weekly lead allocation than non-certified paid suppliers ([IndiaMART help](https://help.indiamart.com/knowledge-base/trustseal/comment-page-3/), [Refrens package overview](https://www.refrens.com/grow/detailed-overview-and-analysis-of-all-indiamart-packages/)). Trustpilot reviewers report fake or irrelevant leads on paid packages ([Trustpilot](https://uk.trustpilot.com/review/m.indiamart.com?page=2)). | This is precisely ADR-003/005/009: a badge and rank that follow payment. Our differentiator is that no sponsored product ever changes a badge, the verification tier or organic rank. I could not find a source for a "Leading Supplier" programme, so it is not analysed here. |
| **Flipkart Ads (PLA)** | CPC; seller sets a daily budget, campaign goal, products and keyword or category targets, plus a CPC bid. Third-party guides quote typical CPC of roughly Rs 1 to 5, up to 10 in competitive periods ([Unbundl](https://unbundl.com/blogs/news/how-to-run-ads-on-flipkart-and-flipkart-minutes), [Olbuz](https://www.olbuz.com/blog/flipkart-product-listing-ads-increase-sales-on-flipkart)). These are agency figures for B2C, not B2B and not official. | Take: campaign / budget / target vocabulary that Indian sellers already know. |
| **Meesho Ads** | Charged per click on the advertised catalogue; campaigns can start at a daily budget as low as Rs 100 ([Meesho supplier](https://supplier.meesho.com/ads), [Robnu guide](https://robnu.com/guides/how-to-start-meesho-ads)). | Take: a very low entry budget suits MSMEs. |
| **Faire (B2B wholesale)** | "Promoted Listings" placement is decided by how good a fit the product is for that retailer, with the slot varying by retailer profile; the brand pays; retargeting for reorders was added later ([Faire help](https://www.faire.com/support/articles/34730939021851), [Modern Retail](https://www.modernretail.co/marketing/the-fastest-growing-business-weve-ever-launched-faire-adds-retargeting-capabilities-to-its-ad-business/)). Promotions are brand-funded with platform-run events and match offers ([Faire promotions](https://www.faire.com/support/articles/39039587047195)). | Take: fit-gated promoted slots are the right B2B model; separate "platform event promotions" from ads. |

### 2.2 India regulatory constraints

Applicability note: the Consumer Protection Act 2019 excludes purchases for resale or commercial purpose, but commentary says B2B e-commerce entities are still within the E-Commerce Rules to the extent a buyer is a consumer (for example a self-employed buyer) ([Trilegal](https://trilegal.com/knowledge_repository/consumer-protection-e-commerce-rules-2020/), [Cyril Amarchand](https://disputeresolution.cyrilamarchandblogs.com/2024/04/commercial-purchases-conundrum-under-consumer-protection-laws/)). Many Indian MSME buyers are sole proprietors. **Design rule: comply as if we are in scope.** Get counsel to confirm before launch (open question 9).

| Instrument | Requirement | Design consequence |
|---|---|---|
| **E-Commerce Rules 2020, r.5(3)(f)** | Explain the main parameters that determine ranking of goods or sellers and their relative importance, in plain language, publicly ([Lexology](https://www.lexology.com/library/detail.aspx?g=40bbcb14-5b11-4625-9a9c-3367688367ab)) | Public "How ranking works" page, generated from code constants (section 8.3). |
| **E-Commerce Rules 2020, r.5(15)** | Sponsored listings distinctly identified with clear and prominent disclosure ([same](https://www.lexology.com/library/detail.aspx?g=40bbcb14-5b11-4625-9a9c-3367688367ab)) | "Sponsored" label on every ad card, not colour-only. |
| **E-Commerce (Amendment) Rules 2026**, notified 9 Sep 2026, **in force 1 Jan 2027** | Restates sponsored-listing disclosure (r.4(8)) and ranking-factor disclosure (r.4(14)); requires compliance with the 2023 dark-pattern guidelines plus **annual audits and a displayed compliance certificate** (r.4(11)); when announcing a price reduction, display the reduced price alongside the **lowest price in the preceding 30 days** (r.4(9)) ([SCC Online](https://www.scconline.com/blog/post/2026/09/14/consumer-protection-e-commerce-amendment-rules-2026-explained/), [BestMediaInfo](https://bestmediainfo.com/mediainfo/mediainfo-digital/govt-tightens-e-commerce-rules-on-search-results-sponsored-listings-and-dark-patterns-12518011)) | The strike-through rule (section 6.2) is set to exactly this 30-day definition. Plan for an annual dark-pattern self-audit. Our launch (Phase 1.5) lands after 1 Jan 2027, so compliance is required from day one. Rule numbers come from secondary summaries; verify against the gazette text. |
| **CCPA Dark Patterns Guidelines 2023** | 13 named patterns, including false urgency, basket sneaking, confirm shaming, forced action, subscription trap, interface interference, bait and switch, drip pricing, **disguised advertisements**, nagging, trick wording, SaaS billing ([Lexology](https://www.lexology.com/library/detail.aspx?g=9be57080-d215-45a8-b988-27acfc083de4), [Trilegal PDF](https://trilegal.com/wp-content/uploads/2023/12/Guidelines-for-Prevention-and-Regulation-of-Dark-Patterns-2023.pdf)) | Mapped in section 11: no fake timers, no unlabelled ads, no pre-ticked boosts, no auto top-up by default, coupon price shown with the post-discount renewal price. |
| **ASCI** | Disclosure labels such as "Ad", "Sponsored", "Paid partnership" must be clear and in the language of the ad ([ASCI influencer guidelines PDF](https://www.ascionline.in/social/wp-content/uploads/2024/03/ASCI-Guidelines-Influencer-Advertising-In-Digital-Media-1.pdf), [Social Samosa on sponsored product suggestions](https://www.socialsamosa.com/industry-updates/asci-mandates-disclosure-ai-generated-influencers-sponsored-product-suggestions-12589329)). These are influencer-focused; ASCI's general code on misleading claims also applies to seller ad copy, but I did not find an ASCI-specific strike-through rule. | Labels are localised ("Sponsored" / "प्रायोजित"). Seller claims in banner creatives (Phase 3) are reviewed. |
| **GST on ad services** | Online advertising services are reported at 18% GST; SAC codes 9983xx ([Busy](https://busy.in/gst-rates/advertisement/), [TAXAJ](https://www.taxaj.com/learn/gst-rate-on-digital-marketing-services-india/)). Secondary sources only. | Wallet top-up carries GST; tax invoice or receipt voucher at top-up (section 5.8). **Have a CA confirm** the SAC, and the time-of-supply treatment of advances. |

**Not researched, flagged for counsel:** whether a prepaid ad wallet usable only for our own services stays outside RBI's prepaid-instrument regime (closed-system), DPDP treatment of frequency-cap identifiers, and WhatsApp marketing opt-in policy.

---

## 3. Goals, non-goals and principles

### 3.1 Goals
- Give sellers a paid visibility product that is honest, cheap to start, and measurable in enquiries, not vanity clicks.
- Give the platform a second revenue line without breaking the trust positioning against IndiaMART.
- Give admins a safe tool to run editorial campaigns (for example "Diwali gifting") and give sellers volume and time-limited offers that are real.
- Give founders levers for growth: coupons on plans, referral credits.

### 3.2 Non-goals
- Selling organic rank, verification badges, "Verified" colouring or lead priority (ADR-002/003/009).
- Buyer-facing dark patterns: fake scarcity, countdowns that reset, inflated "was" prices, auto-enrolled boosts.
- Cross-site tracking or behavioural retargeting in Phase 1.5 (needs a new consent purpose; Phase 3).
- Ads inside lead matching, RFQ supplier suggestions, the manufacturers directory ordering or trust badges.
- Cash-out of any promo currency.

### 3.3 Principles (reconciled with ADRs)

| # | Principle | ADR basis | Enforced by |
|---|---|---|---|
| P1 | The organic list is computed and cached exactly as today; ads are merged after the cache, in fixed slots | 009 | Code review rule plus a test: organic order is identical with ads on and off |
| P2 | Paying gets you into the auction, never above your quality: `score = bid x relevance x trust x pCTR`. Below-floor relevance or trust cannot be bought | 003, 009 | Eligibility gates + multiplicative score |
| P3 | Plan tier (Free/Starter/Pro) has zero effect on ad rank or price | 005 | `plan` is not an input to `decide()` |
| P4 | Every paid slot is labelled; empty slots collapse; unpaid house content is never labelled or styled as an ad, and ads are never styled as organic | 009, CCPA "disguised advertisements" | Shared `SponsoredLabel` component; slot renderer only accepts `AdDecision` |
| P5 | Ads never touch lead matching, lead caps, intent scores or credits | 002 | No dependency from `enquiry` to `ads` |
| P6 | Advertiser transparency: public rate card, itemised spend, auto-refund of invalid clicks, no auto top-up by default, pause anytime, no minimum commitment | 005 | Product rules in section 5.8 |
| P7 | Editorial vs paid firewall: `promotions` has no relation to wallets or invoices | 009 | Separate module and privileges |
| P8 | Discounts are real: reference price = lowest price in preceding 30 days, computed by us | CCPA, Rules 2026 | Section 9.2 |
| P9 | Kill switches per surface and globally, no deploy needed | operational | Section 10 |

---

## 4. Module layout and dependencies

Two new workspace packages, each with one public entry (`src/index.ts`) and its own schema file, following ADR-006.

- `@cnote/ads` (schema `ads.prisma`) depends on `core, db, billing, catalogue, identity`. It does **not** depend on `search` or `enquiry`.
- `@cnote/promotions` (schema `promotions.prisma`) depends on `core, db, billing, catalogue, identity`.
- `search` gains `+ ads, promotions` (organic list, then decorate offers, then merge ad slots). No cycle, because neither new module imports `search`.
- The wallet ledger lives in `billing.prisma` (money in one module; finance role owns it). `ads` calls `billing.spendAdWallet(...)`. Coupon and referral rewards call the existing `billing.grantCredits`.
- Enquiry attribution is a call from the web server action after enquiry creation (`ads.attributeEnquiry`) to avoid an `enquiry -> ads` edge.
- **Refactor prerequisite:** `trustFactor()` currently lives in `packages/search/src/fusion.ts`. Ads must use the identical function, so move it to `@cnote/identity` (next to `getTrustProfiles`) and import it from both. One definition of trust weighting, one disclosure.

```
web/seller/admin apps
   |            |
search ----> ads ----> billing (wallet, credits)
   |          |  \
   |          |   +--> catalogue, identity (trust profile, trustFactor)
   +--> promotions --> billing, catalogue, identity
```

---

## 5. Sponsored Products: product design

### 5.1 Campaign model

`Campaign` (business, objective, budget, schedule, status) has many `AdGroup`s (targeting, max CPC) which have many `AdGroupListing`s (a listing with its own review state) and `AdKeyword`s.

| Field | Decision |
|---|---|
| Objective | `enquiries` (default; optimises for enquiry starts) or `visibility` (impressions weighted). Phase 1.5 supports `enquiries` only. |
| Ad format | **The ad is the listing card** (title, image, price, MOQ, trust badge from the real tier), plus the label. No custom creative for product ads, which removes the misleading-claim surface. Custom creatives exist only for Phase 3 brand banners. |
| Budget | `dailyBudgetPaise` (required, minimum Rs 100, same idea as Meesho), optional `totalBudgetPaise`. Day boundary is IST. Never charged above the daily budget, even if in-flight clicks arrive after exhaustion (platform absorbs the overshoot). |
| Status | `draft -> pending_review -> approved -> active <-> paused`, plus `rejected`, `exhausted` (budget), `ended`, `suspended` (admin). `active` is derived from schedule, wallet balance and eligibility. |
| Entry cost | No minimum commitment, pause any time, no auto top-up unless explicitly enabled with a cap. |

### 5.2 Targeting

| Dimension | Phase 1.5 | Phase 2 | Notes |
|---|---|---|---|
| Keywords with match type (`exact`, `phrase`, `broad`) and negatives | Admin-entered at review from seller's suggestions | Self-serve | Normalised with `normaliseQuery` (handles transliteration and Hinglish). Trademark and competitor-brand keywords are blocked at review. |
| Categories | Yes (leaf or parent) | Yes | Prohibited categories are never eligible (`Category.prohibited`). |
| Locations | State and 3-digit pincode prefix lists | Same | Buyer location from the picked "Deliver to" pincode or the business profile. |
| Buyer business type | Not available | Needs a `Business.businessType` field (does not exist in schema today) | Listed for completeness; do not block on it. |
| Behavioural / retargeting | No | No | Needs a consent purpose (`ads_personalisation`). Phase 3. |

### 5.3 Eligibility gates (all must hold at decision time)

Seller: `verificationTier >= 1`, `trustScore >= 50`, not suspended, positive wallet balance, and no unresolved invalid-traffic or fraud flag. Listing: `status = published`, `moderationStatus = approved`, at least one approved `ListingImage`, category not prohibited, price present. The default `trustScore` for a new business is 50, so "trust >= 50" mostly filters out sellers whose score has decayed. **Recommendation: launch with 60** (open question 3); keep it a config value.

When eligibility flips (trust drops, image rejected, listing archived), the ad silently stops serving within the eligibility cache TTL, and a notification tells the seller why. No charge is made for ineligible periods.

### 5.4 Bidding and pricing

**Phase 1.5: rate card.** A public price list of fixed CPC per category group (for example a floor set per category by staff with `ads.settings`, shown on a public page). Seller picks budget; there is no bid. When several eligible advertisers match a query, slots go by `relevance x trust` with rotation among near-ties. This is deliberately not pay-to-rank: price is fixed and equal, so quality decides.

**Phase 2: CPC auction, generalized second price.**

```
Q_i        = relevance_i x trustFactor_i x pCTR_i            (quality score)
rank_i     = bid_i x Q_i
winners    = top-k by rank_i, subject to eligibility and relevance floor
price_i    = max( reserve(cat, surface), rank_{i+1} / Q_i + increment )   and price_i <= bid_i
increment  = Rs 0.10
```

- `relevance` in [0,1]: exact keyword 1.0, phrase 0.8, broad = token-overlap ratio times 0.5 or semantic similarity, whichever is higher; category-only match capped at 0.4; blended with embedding cosine against the query embedding that search already computed. Weights and the floor `R_min` are **initial guesses** to calibrate offline so that any ad shown would also plausibly rank in the organic top 50 for that query.
- `trustFactor` is the same 0.6 to 1.03 function organic ranking uses.
- `pCTR`: Bayesian-shrunk per (listing, surface, slot), normalised for slot position. Until data exists (Phase 1.5 and early Phase 2), `pCTR` is a constant prior, so `Q = relevance x trust`.
- **Reserve price** per category/surface, set by staff, published. **Max CPC cap** per category so a large seller cannot make the slot unaffordable for MSMEs.
- GSP over VCG: industry-standard, explainable in one sentence to a seller, and the pricing rule can be published. The price is locked at decision time and charged on a valid click, never above the bid.

### 5.5 Placement inventory and hard caps

| Surface | Slots | Hard cap |
|---|---|---|
| **Search results** | Up to **2** above organic, in a labelled "Sponsored" block. Then **1 per 10 organic results** (after result 10, 20, ...). | Ads never exceed 20% of cards on a page. No ads if the query returns fewer than 10 organic results (`minOrganicForAds`). At most 1 ad per seller per page. |
| **Category page** | Same rule as search. | Same. |
| **Product page** | "Sponsored similar": a rail of up to 2 cards, separate from the organic "Similar products" rail. | Max 2. Never on a seller's own product page. |
| **Home** | Phase 2: one labelled "Sponsored picks" rail (max 4 cards). Not inside "Trending" or "Best Selling" tabs, whose names are factual claims. | 1 rail; hero is **not** sold in Phase 1.5 (editorial only). |
| **Never** | Lead matching, RFQ panel "verified suppliers", the Manufacturers directory ordering, TrustBadge, notifications to buyers. | Hard block. |

Rules: an ad listing is removed from the organic list on the same page (no duplicates); empty ad slots collapse (organic moves up); when the listing shows up as both a candidate ad and an organic result, the organic position is kept and the ad slot goes to the next advertiser.

**Frequency capping and pacing.** Per visitor-listing: max 5 served impressions per rolling 24h, and one ad per seller per page. Frequency key is a first-party pseudonymous id (`cnote_vid`) used only for capping and fraud checks; no cross-site tracking. Budget pacing is even across the IST day: eligible while `spend <= dailyBudget x elapsedFraction x 1.2`, otherwise participate with a throttled probability. New campaigns get an exploration allowance so they can gather pCTR data.

### 5.6 Invalid traffic and fraud (Phase 1.5 = rules, Phase 2 = scoring)

Clicks go through a signed redirect `/a/c/{token}`. The token is an HMAC over (impression id, listing, slot, price, issued-at), single use, expiring in 30 minutes, so a click cannot be forged, replayed or repriced.

| Threat | Control |
|---|---|
| Duplicate / accidental | Same (visitor, ad) within 30 min counts once; double-clicks within 2 s are dropped. |
| Bots | Headless or known-crawler user agents, datacenter ASNs, no cookie or JS beacon, zero dwell (< 2 s before bounce) marks `pending -> invalid`. |
| Self-clicks | Buyer session belongs to the same business as the advertiser; shared GSTIN, phone, device id or IP cluster with the advertiser; sellers who click their own ad see no charge and a warning. |
| Competitor click farms | Per (ad, IP /24 or ASN) cap per day; per-ad CTR z-score anomalies against the category baseline; click-to-enquiry ratio collapse; a sudden burst from a single referrer. |
| Wallet drain | Daily budget hard stop; per-campaign click velocity alarm that pauses the campaign and notifies. |

Classification is two-stage: real-time rules label a click `valid` or `pending`; an async job re-scores within 72 hours (same window as the lead refund) and writes an `invalid_click_refund` ledger entry with no ticket. The seller's report shows valid, invalid and refunded counts and the reasons. Every invalidation has a reason code visible to the seller.

### 5.7 Attribution and reporting

- **Attribution:** an enquiry started by the same person or business on that seller's listing within **7 days** of a click, last-click. The click id rides a short-lived cookie and is passed to `ads.attributeEnquiry(enquiryId, clickId)` when the enquiry is created.
- **Ads do not create leads.** A sponsored click leads to a listing page. An enquiry from that page is a buyer-selected enquiry (ADR-002 option 4). The existing lead-credit rules apply unchanged: **the seller pays CPC for the visit and, separately, a lead credit only if they accept the enquiry.** Whether to waive one of the two is an open question (7).
- **Metrics per campaign:** impressions served, clicks (valid/invalid), CTR, spend, average CPC, attributed enquiries, cost per enquiry, enquiry-to-conversation rate, daily-budget utilisation, lost impression share due to budget vs due to quality (tells the seller whether to spend more or improve the listing), top queries (privacy-thresholded).
- **Honest reporting:** show "cost per enquiry" first, and never present a click count without its invalid share.

### 5.8 Billing

- **Ad wallet**: prepaid, integer paise, append-only `AdWalletEntry` in `billing.prisma`, separate from `CreditLedgerEntry`. Reasons: `topup`, `spend`, `refund_invalid_click`, `promo_credit`, `promo_expire`, `refund_to_source`, `adjustment`.
- **Top-up**: minimum Rs 500 (open). GST at 18% is charged on top (SAC and time-of-supply to be confirmed by a CA); the wallet is credited with the ex-GST amount; a GST tax invoice or receipt voucher is generated at top-up, with CGST/SGST or IGST by place of supply (`Business.state`). Paid balance never expires silently and is refundable to source on request, with a GST credit note. Promo credit expires after 90 days (consistent with ADR-005 rollover) and is non-refundable.
- **Spend settlement**: click spend is accumulated in Redis (`INCRBY` paise) for pacing and settled into one ledger row per (campaign, window) by a worker job (idempotent on `(campaignId, windowStart)`). No per-click Postgres write to the wallet, so the ledger is not a hot row.
- **Low balance**: alert at a seller-set threshold (default: 3 days of average spend); campaigns pause when the balance cannot cover the next window. **Auto top-up defaults off**, and enabling it requires an explicit confirmation showing the cap (avoids CCPA "SaaS billing" and "subscription trap" patterns).
- **Prerequisite:** `billing.subscribe` currently mocks payment capture. Real payment collection (a hosted-checkout gateway, no card data held, consistent with the Phase-1 "no card data" rule) and GST invoice generation must exist before self-serve top-up. For the pilot, finance credits the wallet by hand after a bank transfer (`billing.adjust` path) and issues the invoice from the accounting system.

### 5.9 Admin review and approval

New privileges: `ads.read`, `ads.review`, `ads.suspend`, `ads.fraud.review`, `ads.settings` (see schema doc for role mapping).

- **Review queue** (`ads.review`): campaigns in `pending_review`, showing seller tier and trust, listings and images, keywords with match types, geo targets, budget and CPC, category floor price. Reviewers approve or reject with a reason code (`irrelevant_keyword`, `trademark`, `prohibited_category`, `misleading_listing`, `low_quality_listing`). Keywords and listing links are reviewed individually, so one bad keyword does not reject a campaign. Target review SLA: one business day. Every action goes through `audited()`.
- **Re-review triggers:** material edits (new keywords, new listings, category change, budget change over 2x) return the affected item to review; budget decreases and pauses do not.
- **Fraud queue** (`ads.fraud.review`): flagged campaigns and click clusters, with the ability to invalidate and refund in bulk.
- **Kill switch** (`ads.suspend`): suspend a campaign or a business's ads immediately; the eligibility cache is invalidated on suspension.

### 5.10 Disclosure

**Card label.** A neutral pill top-left of the card reading "Sponsored" (Hindi: "प्रायोजित"), text not colour-only, AA contrast, announced by screen readers as "Sponsored listing". It must not use `brand` or `accent` colours, which are associated with primary actions and the verified tick. An info affordance opens: *"This seller paid to show this product. Sponsored products are matched to your search and shown only for sellers who meet our trust requirements. Paying does not change a seller's verification badge or the normal search order. How ranking works"*.

**Sponsored block.** At the top of search results, the block carries a heading "Sponsored" with a subtle divider so the boundary with organic results is unmistakable (the thin-border criticism of Amazon's layout above).

**Ranking disclosure page** (`/how-ranking-works`): see section 8.3.

---

## 6. Promotions

Four distinct systems, kept apart because they have different owners, money flows and legal exposure.

### 6.1 Platform promotions (editorial, admin-run)

Purpose: home hero banners, curated collections ("Diwali gifting"), category spotlights, seasonal landing pages.

- **Never sold.** No wallet, no price, no seller-paid inclusion (principle P7). If a seller wants to pay for a banner, that is a Phase 3 ad (`ads` module, labelled).
- **Entity model:** `Promotion` (kind, status, schedule, audience, priority) with placements, per-locale content (headline, subline, CTA label and href, image key, alt text) and, for collections, ordered items (listing, category or business) with an editor's note.
- **Selection of items is editorial on merit**, and items must pass the standard eligibility (published, approved, approved image; seller tier at least 1). Items are not free promotion for sellers who complained about rank, so record the curator and a reason in the audit log.
- **Scheduling:** `startsAt` / `endsAt` in IST; readers query `status = approved AND now in [startsAt, endsAt)` through a 60-second cache, so no cron flip is needed and a bad banner can be pulled instantly (`archive`).
- **Targeting:** audience segment (`all`, `signed_in`, `buyers`, `sellers`), language, and region (state list). Simple and rule-based; no behavioural profile.
- **Workflow (maker-checker):** author (`promotions.manage`) drafts; a different staff member with `promotions.publish` approves. Same split as `templates.manage` and `templates.publish`. Images go through `@cnote/media` and must carry alt text.
- **Templates:** an admin picks a layout template (`hero_split`, `hero_full_bleed`, `collection_rail`, `category_spotlight`), defined in code with slots (like `defineTemplates` for email), so staff own the words and images but cannot break the layout or the mobile and 3G budget (image size caps, `next/image` sizes).
- **Promotion emails:** category `marketing` in the templates registry, sent only to persons with a current `marketing` consent (ADR-010), respecting `NotificationPreference("marketing")`, max one marketing email per person per week (config), unsubscribe link, dedupe key `promo:{promotionId}:{personId}`.

### 6.2 Seller offers on listings

Three offer kinds, each validated by a typed rule set (discriminated union, zod), auto-checked, and reviewable.

| Kind | Terms | Validation |
|---|---|---|
| **Volume tiers** | `[{minQty, unitPricePaise}]` | First tier `minQty >= listing MOQ`; tiers strictly increasing in qty and strictly decreasing in unit price; max 5 tiers; all prices below the listing base price. |
| **Limited-time price** | `offerUnitPricePaise`, `startsAt`, `endsAt` | Max 30 days; **cooldown of 14 days** after an offer ends before another timed offer on the same listing (prevents "permanent sale"); discount at least 3% and at most 50% before it goes to manual review (bait and switch guard); no price below a category floor without review. |
| **Free delivery over MOQ** | `minQty` or `minOrderValuePaise`, region list | Seller declares who pays; shown as "Free delivery on orders of 500+ pcs to Karnataka"; no other shipping terms implied. |

**Honest strike-through rules (CCPA drip pricing, false urgency and bait-and-switch; Rules 2026 r.4(9)).**
1. The reference price is **computed by the platform** as the lowest listing price in the preceding 30 days from an append-only price history. The seller never types it. Because it is the lowest, not the highest, raising the price to create a bigger "discount" is impossible.
2. If the listing has less than 30 days of history, or the price changed fewer than N days ago, show the offer price only, with no "was" price and no percentage.
3. The percentage shown is computed from the platform reference price, rounded down.
4. Countdowns and "ends soon" use the real `endsAt`; the offer really ends and cannot be silently extended (extension = a new offer subject to cooldown).
5. No scarcity claims ("only 3 left"): we do not hold verified inventory.
6. Show units, MOQ, validity, applicable regions and GST treatment ("+ GST as applicable", consistent with normal price display) on the card and product page. No fee appears later that was not in the displayed price (drip pricing).
7. **Honouring:** offers are indicative unit prices the seller must honour for enquiries at or above the tier quantity during the window. A buyer can tap "Seller did not honour this offer"; upheld reports feed the trust score (ADR-003) and, above a threshold, suspend the seller's offer privileges.

Offers **do not affect organic rank** (no price or offer boost). They add a chip, an "Offers" filter and an organic "Deals" page ordered by the normal relevance x trust.

**Approval flow:** `draft -> auto_checked -> active` when all rules pass and the seller is tier >= 1 with an approved listing; `needs_review` (staff with `offers.review`) when it trips a flag (deep discount, price below floor, seller with prior upheld honour complaints); `rejected`, `expired`, `cancelled`. If the listing's price or MOQ is edited, the offer is re-validated; if invalid it ends with reason `listing_changed`.

**Prerequisite:** a `ListingPriceHistory` table in the catalogue module (append-only, written when `pricePaise` changes). Catalogue does not have this today.

### 6.3 Coupon and discount codes for subscription plans

- **Types:** `percent` (with a max discount), `flat`, `extra_credits` (bonus lead credits via `billing.grantCredits`, 90-day expiry, refType `coupon`), and `ad_credit` (promo wallet credit; restricted, needs super_admin to create).
- **Rules:** validity window; global redemption cap; per-business limit (default 1); optional plan list; optional first-purchase only; minimum plan price. Discounts apply to the **first billing period only** and never touch the ad wallet top-up amount.
- **Stacking:** one coupon per checkout, never stackable with another coupon. Referral rewards are credits, not price discounts, so they are a different currency and can co-exist. No coupon stacks with the free plan.
- **Checkout honesty (subscription-trap and drip-pricing guard):** the price line reads, for example, "Rs 499 for month 1, then Rs 999 per month. Renewal needs your confirmation each month." Nothing auto-renews (ADR-005).
- **Abuse controls:** redemption keyed to the business and the GSTIN (one per GSTIN, and tier >= 1 required for values above a threshold); code attempts rate-limited by person and by IP through the existing Redis `rateLimit`; one generic "This code is not valid" error for wrong, expired or exhausted codes (no enumeration); random 10+ character codes for targeted campaigns; per-code velocity alarms; cancellation does not free the redemption; every redemption is an append-only row with an idempotency key `(coupon, business, checkoutRef)`. Coupon creation above 50% or above a rupee ceiling needs a second approver.
- **Integration:** `promotions.quoteCoupon(businessId, planCode, code)` returns `{discountPaise, terms}`; `billing.subscribe` gains an optional `discount: {paise, ref}` input. Billing never imports promotions, and promotions calls billing (no cycle).

### 6.4 Referral credits

- Referrer gets a personal link; **no address-book import and no platform-sent messages to non-users** (DPDP and spam risk). The referrer shares it themselves, for example on WhatsApp.
- One referrer per referee (unique). The referee must be a new person and a new business.
- **Qualifying action, not signup:** the referee reaches verification tier 1 and either publishes a first approved listing (seller) or completes a first verified enquiry (buyer). Signup alone earns nothing.
- **Reward:** lead credits to both sides (`billing.grantCredits`, refType `referral`, 90-day expiry). Never cash, never wallet-withdrawable. Released after a 7-day hold for fraud review.
- **Caps and abuse controls:** a quarterly cap per referrer; self-referral and ring detection through shared GSTIN, phone, device, IP cluster and bank account; rejected referrals visible to the referrer with a reason (no silent denial, same principle as the lead auto-refund).

---

## 7. Stitching into existing modules

### 7.1 Search and catalogue

Today `searchListings` caches the organic result for 60 seconds by a hash of the normalised query, category and limit. The ad call must sit **outside** that cache.

```
searchWithAds(req):
  organic   = searchListings(q, category, limit)            // unchanged, cached 60s
  decorated = promotions.attachOffers(organic)              // one indexed lookup, cached
  ads       = ads.decide({surface, query, queryEmbedding, categoryId,
                          buyerRegion, organicListingIds, organicCount, visitorKey})
  return merge(decorated, ads)                              // fixed positions, section 5.5
```

- `queryEmbedding` is the embedding search already computes for the organic path, so `decide` needs no model call.
- Merge is a pure function with unit tests: no reordering of organic entries, dedupe, caps, collapse of empty slots.
- `SearchHit` gains optional `sponsored?: {impressionToken, clickHref}` and `offer?`. Organic hits never carry `sponsored`.
- Impression logging is server-side "served" counting into Redis, rolled up hourly. Only clicks are stored individually.

### 7.2 Ad decision hot path (target: p95 < 30 ms, no DB call)

1. **Eligible-candidate snapshot** in Redis (and an in-process LRU with a 15 s TTL): per category, the list of ad-group-listings with bid or rate, keywords, geo targets, trust snapshot, pCTR prior and the listing's 256-dim embedding. Rebuilt on events (`ListingModerated`, `ListingImageModerated`, `TrustScoreChanged`, `AdCampaignReviewed`, `AdCampaignStatusChanged`, `ListingArchived`) and by a 60-second sweep. Embedding version is part of the key, so an embedding bump invalidates it (mirrors `embeddingVersion`).
2. Match keywords, category and region in memory; compute relevance; drop below `R_min`.
3. Check budget and pacing with a single Redis pipeline (`ads:budget:{campaignId}:{ISTdate}`).
4. Frequency cap check (`ads:freq:{visitorKey}:{listingId}`, 24 h TTL).
5. Rank; price; sign the impression token; return.

Failure mode: any error, timeout over 25 ms, or Redis outage returns **zero ads**, and organic results render normally. Ads are never on the critical path of search.

### 7.3 Notifications and templates

Uses the `@cnote/templates` registry pattern (code owns keys and variables; staff own copy). New template keys:

| Key | Category | Trigger |
|---|---|---|
| `ads.campaign_approved` / `ads.campaign_rejected` (with reason) | transactional | `AdCampaignReviewed` |
| `ads.budget_exhausted` | transactional | `AdBudgetExhausted` |
| `ads.wallet_low` | transactional | `AdWalletLow` |
| `ads.ineligible` (why an ad stopped) | transactional | `AdIneligible` |
| `ads.invalid_click_refund` | transactional | `AdClickInvalidated` (batched daily) |
| `offer.approved` / `offer.rejected` / `offer.ending_soon` | transactional | offer events |
| `promo.announcement` | **marketing** | `PromotionPublished`, consent-gated |
| `referral.qualified` / `referral.rewarded` | transactional | referral events |

Seller ad and offer alerts reuse the `billing` and `listings` notification preference categories, and promotion emails use `marketing`. No new preference category is needed in Phase 1.5. WhatsApp marketing templates require an opt-in; verify Meta's current policy before enabling that channel.

### 7.4 Billing

New `AdWalletEntry` ledger and functions `topUpAdWallet`, `spendAdWallet(tx, ...)`, `refundAdSpend`, `getAdWalletBalance` (public contract additions, not breaks). Promo credit reuses the `promo_credit` reason. The finance role gets ledger visibility; `billing.adjust` covers manual credit.

### 7.5 Admin RBAC

Twelve new privileges (schema doc, section 4) added to `PRIVILEGES` in `rbac.ts`, and role mapping additions. `ads.settings` and `ad_credit` coupon creation are super_admin only.

### 7.6 Analytics events

New event types and payloads are in the schema doc (section 3). They follow the existing rules: emitted inside the same transaction as the state change, versioned at 1, idempotent handlers. High-volume signals (impressions) are **rollup events** rather than per-impression events, to keep the outbox and the event log healthy.

### 7.7 Redis keys and TTLs

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `ads:cand:v{n}:{categoryId}` | JSON blob | 60 s (event-invalidated) | Eligible candidate snapshot |
| `ads:budget:{campaignId}:{istDate}` | counter | 36 h | Daily spend for pacing and hard stop |
| `ads:freq:{visitorKey}:{listingId}` | counter | 24 h | Frequency cap |
| `ads:imp:{hour}:{campaignId}:{listingId}:{surface}:{slot}` | counter | 3 h | Served-impression rollup buffer |
| `ads:click:seen:{visitorKey}:{adKey}` | flag | 30 min | Click dedupe |
| `ads:kill:{surface}` / `ads:kill:all` | flag | none | Kill switches |
| `promo:active:{surface}:{locale}` | JSON | 60 s | Editorial promotions |
| `coupon:attempts:{personId}` and `:{ip}` | rate limiter | 1 h | Code enumeration guard |

### 7.8 Performance and low-bandwidth budget

- Ad decision p95 < 30 ms (in memory, cached eligibility). Search and category page TTFB budget unchanged.
- Sponsored cards use the same image pipeline and lazy-loading as organic cards, with no extra client JS beyond the info popover. Promotion banners have image size caps and responsive `sizes`, and the hero must not block on client JS (DESIGN.md accessibility and performance section).

---

## 8. Home page and ranking disclosure

### 8.1 Home page anatomy changes (DESIGN.md sections 1 to 5)

| Section | Change |
|---|---|
| Hero (2) | Editorial `hero` promotion slot is optional and not paid. The hero H1 and search remain primary; a promotion can replace one of the three value cards or add a thin announcement strip. |
| Shop by Category (3) | Optional editorial spotlight tile ("Diwali gifting collection"). |
| Promo panels (4) | Panel slots may be driven by editorial promotions; the "Get Quotes from Verified Suppliers" panel is never ad-driven. |
| Popular Products (5) | Tabs "Trending" and "Best Selling" stay organic. Phase 2 adds a separate "Sponsored picks" rail below, labelled. |

### 8.2 Component contract

`SponsoredLabel` and `SponsoredBlock` live in `@cnote/ui` (used by web features across surfaces). `ProductCard` accepts `sponsored` only through the `AdDecision` type, so an unlabelled ad cannot be constructed in typed code.

### 8.3 Ranking-parameter disclosure page

Public page `/how-ranking-works`, generated from constants exported by `search` and `ads` (`RANKING_DISCLOSURE`), so the page cannot drift from the code (a snapshot test fails if a constant changes without a content-version bump). Contents:
1. **Organic results:** ordered by how well the listing matches your search (text and meaning), adjusted by the seller's trust score (verification, response reliability, buyer feedback, dispute record) which moves the score by up to roughly 40%, and a small boost for sellers in the buyer's stated city. Plan, payment and ads do not affect it.
2. **Sponsored results:** what qualifies (tier, trust, approved listing and images), how the slots are placed, the caps, how price is set (rate card, later auction), how quality is computed, and that a higher bid cannot outrank a much better match.
3. **What we never do:** sell verification, sell lead priority, sell organic rank.
4. Last updated date, contact for grievances, and a change log.

---

## 9. Phasing

| Step | Scope | Gate to start | Exit signal |
|---|---|---|---|
| **1.5a: Editorial + offers + disclosure** | `promotions` module: admin promotions with maker-checker and templates; seller offers (volume tiers, timed price, free delivery) with price history; `SponsoredLabel` component (no ads yet); `/how-ranking-works`; RBAC additions; marketing template keys | Phase-1 features stable | Offers active on a meaningful share of published listings; zero honour-complaint spikes |
| **1.5b: Manual sponsored slots** | `ads` module minimal: rate card, campaigns created by ops on behalf of ~10 to 20 pilot sellers (no self-serve UI), manual approval, fixed CPC, wallet topped up by finance, search and category slots only, click redirect and dedupe, rule-based invalid filtering, monthly statement | Payment collection and GST invoicing exist (or manual pilot); disclosure page live; counsel sign-off | Sponsored CTR, enquiry quality and complaint rate inside guardrails (section 10) for 8 weeks |
| **1.5c: Growth levers** | Coupons on plans; referral credits | Real payment collection | Referral fraud rate acceptable; no coupon-stacking incidents |
| **2: Self-serve + auction** | Seller campaign UI, keywords self-entry, GSP auction with reserve and cap, pCTR from logs, product-page and home rail, budget alerts, automated fraud scoring, invalid-click auto-refunds, report UI | 1.5b guardrails green, enough advertisers per category to make an auction meaningful | Advertiser ROI (cost per enquiry) stable or improving |
| **3: Brand and intelligence** | CPM brand banners with creative review, consent-based behavioural targeting (`ads_personalisation`), ML CTR, AI-assisted campaign creation (ADR-008: human-confirmed), bid guidance from price intelligence (ADR-022, k-anonymous) | Phase 2 stable, DPDP review | n/a |

**Rule for cold categories:** ads show only where the organic list is healthy (`minOrganicForAds`). We would rather show no ad than a poor one.

---

## 10. Metrics and guardrails

| Metric | Why | Guardrail (config, tune with data) |
|---|---|---|
| Buyer trust in results (periodic in-product question and a "Report this ad" tap) | Trust is the product | Any sustained drop after ads launch triggers a rollback review |
| Sponsored CTR vs organic CTR at the same position band | Irrelevant ads have low CTR | Alert if sponsored CTR is far below organic; raise `R_min` |
| Enquiry quality from ads: intent score and enquiry-to-conversation vs organic | Ads must not bring worse leads | Parity target; alert on a persistent gap |
| Ad-related complaint rate (reports, support tickets per 1,000 clicks) | Direct trust signal | Alert threshold agreed before launch |
| Median trust score of ad winners vs organic top 10 | No adverse selection | Winners' median at or above organic median |
| Ad load per page and per session | Layout stays organic-first | Hard 20% cap in code |
| Ads as % of trailing-90-day revenue | Avoid incentive drift toward ad revenue over subscription and leads | **Proposed cap: 20%**; breach requires an explicit founder decision (open question 5) |
| Invalid click rate, refunded paise, time to refund | Advertiser trust | Refund within 72 h; report shown to seller |
| Advertiser cost per enquiry and repeat-spend rate | Product value | Track by category |
| Budget under-delivery share | Advertisers pay for reach they do not get | Alert when consistently high |
| Offer honour complaints per 1,000 offers; % offers auto-ended for listing change | Offer credibility | Suspend offer privileges above threshold |
| Coupon redemption vs code-attempt failure ratio; referral rejection rate | Abuse detection | Velocity alarms |

**Kill switches:** per surface and global (`ads:kill:*`), promotions archive, offer suspension per seller. All three work without a deploy and are logged.

## 11. Compliance mapping (dark patterns and disclosure)

| Pattern (CCPA 2023) | Where it could appear | Control |
|---|---|---|
| Disguised advertisement | Ad cards, banners | `SponsoredLabel` mandatory, typed API, distinct block, AA contrast |
| False urgency | Offer countdowns, "ends soon" | Real `endsAt` only; no scarcity claims |
| Drip pricing | Offers, coupons, shipping | All conditions on card, coupon renewal price shown, no late add-ons |
| Bait and switch | Deep discounts, low-price teasers | Discount bounds, review, honour reporting |
| Subscription trap / SaaS billing | Wallet auto top-up, coupon first-month price | Auto top-up off by default and capped; renewals need confirmation; cancellation self-serve |
| Interface interference / trick wording | Campaign creation, boost toggles | No pre-ticked options; plain language; cost preview before submit |
| Confirm shaming / nagging | Upsell prompts to sellers | No guilt copy; upsell prompts capped and dismissible |
| Basket sneaking | Checkout | No add-ons in plan checkout without explicit tick |

**Annual dark-pattern audit** (Rules 2026 r.4(11), from 1 Jan 2027) should cover these surfaces; record the audit and publish the certificate if counsel confirms applicability.

## 12. Risks

| Risk | Mitigation |
|---|---|
| "You are IndiaMART now" perception | Public rules; organic never changed; label and disclosure page; ranking parity test in CI; guardrails and kill switch |
| Small sellers priced out by large ones | Rate card first; max CPC cap and per-seller page cap; low minimum budget |
| Click fraud and competitor drain | Signed single-use click tokens; rules and re-scoring; auto-refund; daily budget hard stop |
| Thin inventory in Phase 1 (too few advertisers per query) | Collapse empty slots; `minOrganicForAds`; no house ads styled as sponsored |
| Wallet liability and GST errors | Append-only ledger; CA sign-off before launch; refund-to-source with credit note; manual pilot first |
| Regulatory drift (B2B applicability unclear; rules effective 1 Jan 2027) | Build to the strictest reading; counsel review; disclosure generated from code |
| DPDP: frequency and fraud identifiers | Pseudonymous first-party id, short TTL, contextual-only targeting; consent purpose before any personalisation |
| Conflict with lead exclusivity | Ads never feed matching; ads-attributed enquiries use existing lead rules; reviewed in open question 7 |
| Coupon and referral farming | GSTIN-keyed limits, holds, rate limits, credits not cash |
| Model complexity for a small team | Two thin modules, rule-based Phase 1.5, auction and ML deferred |

---

## 13. Open questions for the founder

1. **Sponsored in Phase 1.5 at all?** The lowest-risk path is 1.5a (editorial + offers + disclosure) first, and turn on 1.5b only after the organic experience is proven. Confirm the order.
2. **Rate card vs auction:** confirm Phase 1.5 uses public fixed CPC (quality-ranked rotation) and defers GSP to Phase 2.
3. **Trust floor:** 50 (as requested) or 60? New sellers default to 50, so 50 gates almost nothing.
4. **Pilot pricing:** initial CPC rate card values and minimum top-up (Rs 500 proposed) need commercial input; third-party B2C CPC figures are not B2B evidence.
5. **Ad revenue cap:** is 20% of trailing revenue the right guardrail, and is it a board-visible commitment or an internal one?
6. **Payments:** which gateway and who issues GST invoices at top-up; today payment capture is mocked in `billing`.
7. **Double charge:** should an ad-attributed enquiry that becomes an accepted lead cost CPC plus a lead credit (proposed, transparent) or credit only?
8. **`Business.businessType`:** add it now (enables buyer-type targeting later) or defer?
9. **Legal:** confirm E-Commerce Rules applicability to a B2B-only platform, closed-system wallet treatment, SAC and advance-payment GST, and WhatsApp marketing opt-in.
10. **Vertical (ADR-011):** category floors and eligibility rules are config, but pilot advertiser density depends on which vertical you pick.
