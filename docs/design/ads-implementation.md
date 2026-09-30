# Sponsored Products: implementation notes

What shipped for ADR-024 (Phase 1.5: public rate card, manual approval, no bidding) against `docs/design/promotions-and-sponsored.md`. Read that for the why; this file is the what, the flags and how to launch.

## Founder decisions applied (all configurable)

| Decision | Default | Where to change |
|---|---|---|
| Whole feature behind a flag | `ADS_ENABLED` unset = off. Off: nothing is served, sellers see "coming soon", the disclosure page says so, admin can still configure and review. | env |
| Trust floor | 50 (schema refuses values below 50) | `AdConfig.trustFloor` or `ADS_TRUST_FLOOR` |
| Verification tier | >= 1 | `AdConfig.minVerificationTier` or `ADS_MIN_TIER` |
| Ad-attributed enquiry cost | CPC only for a valid click; the lead credit is charged separately only if the seller accepts the lead (unchanged organic rule; ads never touch `enquiry`/`billing` lead credits) | code (no path exists) |
| Ad revenue cap | 20% of trailing-90-day revenue, monitoring alert only (admin overview + daily job log; nothing is switched off) | `AdConfig.revenueCapPct` or `ADS_REVENUE_CAP_PCT` |
| Pricing | fixed public CPC per category and placement, ranked by relevance x trust, manual approval | `/ads/settings` in admin |

Precedence for every knob: built-in default < environment < `AdConfig` row (staff, `ads.settings`, no deploy). Full list: `packages/ads/src/config.ts`.

## Package `@cnote/ads`

- Seller CRUD (zod, ownership on every call): campaigns, ad groups, listings, keywords; `submitCampaign` -> review queue. A budget more than doubling, or targeting changes, return the item to review; decreases and pauses never do.
- Staff review per listing, keyword and ad group, then a campaign decision; suspend (kill switch), unsuspend, suspend a business; invalid-traffic queue with bulk invalidate + automatic refund. Every staff function is called from an `audited()` admin action.
- Eligibility sweep (`runEligibilitySweep`, every 60 s and on moderation/trust/verification events): trust floor, tier, listing published + approved (LIVE db), approved image, price, category not prohibited (ancestors included), rate exists, wallet funded. Verdicts are persisted on `AdGroupListing`, `AdIneligible` and status events are emitted, and a JSON snapshot goes to Redis (`ads:snap:v1`) plus a 15 s in-process copy.
- Decision `getSponsoredSlots({ query, categoryId?, surface, organicListingIds, limit?, visitorId?, buyerState?, buyerPincode?, excludeSellerBusinessId?, similarity? })`. In-memory match, relevance (keyword exact 1.0 / phrase 0.8 / broad overlap x 0.5, title overlap x 0.6, category-only 0.4, optional embedding similarity refines but cannot create a match), x `trustFactor` (same formula as organic; parity is tested), near-ties rotate, one ad per seller and listing, never an organic duplicate, frequency cap (5 per visitor/listing/day), kill switches, budget and pacing from Redis in one pipeline. Any error or > 25 ms returns zero ads. Slots: search/category at most 2, 1 per 10 organic results, never more than 20% of cards, none under 10 organic results; product rail up to 2.
- Clicks: `recordClick(token, ctx)` verifies an HMAC single-use token (unique `tokenId`), then bots (UA list), duplicates (30 min per visitor/ad), self-clicks (business or member), rate spikes (per network per hour, per campaign per minute -> `pending`), wallet headroom (serialised per seller), and reserves budget with an atomic Lua counter (daily and total). Only `valid` clicks are ever debited. `rescoreClicks` (every 30 min, 72 h window) invalidates clusters and repeat visitors and promotes clean pending clicks; an invalid click already settled is refunded to the wallet with no ticket.
- Settlement `settleSpend` (hourly job, idempotent): one ledger debit and one `AdSpendSettlement` per campaign per IST day (`campaignId, windowStart`), capped at the balance (never negative; the shortfall is reported, the platform absorbs it and the sweep halts the campaign for "wallet"). Impressions are buffered in Redis and rolled up hourly (`rollupImpressions`, upsert with SET semantics, one event per campaign/surface/hour). `checkWalletLow` (once a day per business), `checkRevenueCap`.
- Attribution `attributeEnquiry`: last valid/pending click by the same buyer within 7 days, by click id, by listing, or by enquiry category; idempotent per enquiry. The `EnquiryCreated` handler attributes signed-in buyers automatically (the event has no listing, so it matches on buyer business and category).
- Reports `getCampaignReport` / `getAdvertiserOverview`: cost per enquiry first, invalid share always beside clicks, refunds, lost impression share (budget vs quality).
- `worker` (name `ads`): handlers + jobs listed in `src/worker.ts`.

## Ad wallet (`packages/billing/src/ad-wallet.ts`)

Append-only, integer paise, per-business advisory lock, idempotency keys on every write (`topup:{ref}`, `settle:{campaign}:{windowStart}`, `invalid:{clickId}`, `promo:{type}:{id}`, `adjust:{ref}`, `refund_src:{ref}`, `promo_expire:{lot}`). `creditTopUp` (optionally writes `AdTopUp` + `AdWalletToppedUp` when GST data is passed; the payments agent calls it from checkout fulfilment), `grantAdPromoCredit` (expires, spent first, non-refundable), `debitSpend(Tx)`, `refundInvalidClick(Tx)`, `refundAdWalletToSource` (paid balance only), `adjustAdWallet` (no overdraw), `expireLapsedAdPromo`, `getAdWalletBalance(Tx)`, `getNonAdRevenuePaise`. Property tests check the replay against an independent model (balance never negative, expiry, ordering); DB tests cover concurrency and idempotency.

## Tests (required by ADR-024)

- Organic integrity (`packages/ads/test/organic-integrity.test.ts`): 60 random queries, limits and fixtures show `searchListings` returns identical ids, order and scores with ads on and off, ads never duplicate an organic id and organic hits never carry `sponsored`; a price reshuffle does not change the winner; a source scan asserts `packages/search` never imports ads.
- Eligibility matrix, slot rules (caps, share, no duplication, collapse), frequency cap, kill switches, pacing under concurrency (40 parallel clicks against a Rs 100 budget charge exactly 20), wallet headroom under concurrency, invalid-click rules, settlement idempotency and concurrency, refunds, re-scoring, attribution, reports, monitors, rate card versioning, config layering. Run `pnpm --filter @cnote/ads exec vitest run --coverage` (about 95% statements). Test files run one at a time (shared Redis keys).

## Web (buyer)

- Search page (`app/[locale]/(discover)/search/page.tsx`, the route that actually exists): slots are decided per request after the cached organic list, rendered in a labelled dashed block above the grid (`SponsoredBlock`) and inline positions via `mergeSponsored`. JSON-LD stays organic-only.
- Label (`features/ads/label.tsx`): visible text pill "Sponsored" / "प्रायोजित" top-left of the image, neutral ink on white with a solid border (not brand or accent), screen-reader text "Sponsored listing", explanation and a link to the disclosure page in the block. Ad links are `rel="sponsored nofollow noopener"`.
- Click route `app/ad/[token]/route.ts`: records the click then 302s to `/p/<listingId>` (locale kept via `?l=`); sets `cnote_vid` (visitor, 30 days) and `cnote_ad_click` (click id, 7 days, for attribution); never cached; always redirects.
- `SponsoredSimilar({ listingId })` (`features/ads`): server wrapper with no cookies/headers (the product page stays ISR) plus a client island that fetches `app/api/ads/similar/route.ts` after hydration. Empty rails collapse. It never shows a seller's own ads on their own listing.
- Disclosure page `app/[locale]/ranking-and-ads/page.tsx` (ISR 10 min): numbers come from `RANKING_DISCLOSURE` and the live config. Strings: `messages/<locale>.ads.json` (namespace `ads`; all 8 locales, since the parity test requires every locale).

## Seller and admin

- Seller `(portal)/ads`: overview (wallet, KPIs, campaigns, public rate card, wallet activity), `new` (stepper-style builder with budget presets, minimum, live cost preview), `[id]` (status with plain-language halt reasons, per-product eligibility reasons, per-keyword review state, budget, controls, results with lost impression share and non-charged clicks). "Coming soon" when the flag is off.
- Admin `(console)/ads`: overview (flag state, revenue-cap monitor, kill switches), `review` + `review/[id]` (per-item decisions, seller tier/trust, images, keywords with match type, geo, budget, default CPC), `campaigns` (suspend/lift), `traffic` (+ per-campaign click review and bulk invalidate), `settings` (rate card versions + all config), `wallets` (pilot credit after a bank transfer, `billing.adjust`). All mutations use `audited()`; nav entry added in `components/shell.tsx`.

## How to launch

1. Counsel sign-off and the disclosure page live (it ships with this change). Confirm payment or the manual-pilot invoicing path (finance credits wallets on `/ads/wallets`).
2. Publish rates on `/ads/settings` (at least the platform default for `search`, `category`, `product_similar`); commercial values are still open (open question 4).
3. Add `/ranking-and-ads` to `LOCALIZED_PREFIXES` in `apps/web/src/i18n/config.ts`, and `/ad/` and `/api/ads/` to `robots.ts` disallow (see gaps).
4. Onboard 10 to 20 pilot sellers, fund wallets, approve campaigns in `/ads/review`.
5. Set `ADS_ENABLED=true` on web, seller, admin and worker; set `ADS_TOKEN_SECRET` (falls back to `JWT_SECRET`, required in production). The worker's `ads` jobs build the first snapshot within a minute (the first request also triggers a rebuild).
6. Watch admin `/ads`: revenue share, invalid-traffic queue, kill switches. Roll back with the global kill switch (no deploy) or `ADS_ENABLED=false`.

## Known gaps

- Buyer location (`buyerState`, `buyerPincode`) is supported by the decision but the search page does not pass it yet (no "Deliver to" reader wired), so geo-targeted campaigns do not serve there.
- `similarity` (embedding) is an optional input; the web page does not pass it (it would need an extra DB read). Keyword, title and category signals decide.
- Snapshot is one Redis blob with in-memory indexes; shard per category if the advertiser set grows past a few thousand listings.
- Visitor id cookie is only set by the click route and the similar-products API, so a first search page view has no frequency cap.
- The enquiry form should pass the `cnote_ad_click` cookie to `attributeEnquiry` for exact attribution; until then the `EnquiryCreated` handler matches on buyer business and category.
- Notifications (`ads.*` templates) are events only; the notifications/templates agents own the registry entries. Auto top-up, GSP auction, home rail and brand banners are Phase 2/3, not built.
- Refunds after a partially covered settlement refund the full click price even if the original debit was capped.

## Mobbin references

Consulted with the Mobbin MCP (web). Nothing copied: layouts and behaviours adapted to `@cnote/ui` tokens and our honesty rules.

| Reference | What we adopted |
|---|---|
| [Eventbrite: creating an ad campaign](https://mobbin.com/flows/2b1b73cc-54f8-4cee-9c27-0f7e4baf8bfe) | Step order (settings, targeting, payment/review) and a persistent summary; preset daily budgets with a custom field and a stated minimum; a confirmation that says review takes time ("about one business day"). |
| [Whop: launch a campaign](https://mobbin.com/flows/be58f582-0c25-4b23-a441-bd0a60e801b0) | Inline minimum-budget validation with preset chips beside a single amount field; terms line before launch. Not adopted: reach estimates (no honest data yet). |
| [Nextdoor: create a campaign](https://mobbin.com/flows/e467955c-6929-449e-a73f-e8e3ce58074e) | Plain campaign-name-first flow and help links; not adopted: objective picker (Phase 1.5 has one objective). |
| [Reddit Ads dashboard](https://mobbin.com/screens/c7973aa1-770a-4341-b8bc-94ac75d36669) and [Pinterest ad reporting](https://mobbin.com/screens/25a39159-97db-439c-a703-91b66ac3aa53) | KPI tile row above a campaign table with a daily breakdown; the "reporting is not real-time" note. We reordered: cost per enquiry first and the invalid share beside clicks (design 5.7). |
| [Klarna balance](https://mobbin.com/screens/dd9d36fe-0716-4233-b638-c78c96afa6e8), [Revolut add money](https://mobbin.com/screens/ff0f3124-3117-4b9a-9154-e0b3bebcc887), [Wise add money](https://mobbin.com/screens/d80a4a2c-1a60-416e-9dc6-e1be18410a24) | Wallet balance as the headline number, a transaction list with signed amounts, preset amounts. Card entry deliberately not built (no card data, hosted checkout later). |
| [Tripadvisor sponsored block](https://mobbin.com/screens/cbf9b7ae-2bbe-419d-a93e-bccf02840f32), [GoDaddy "Promoted" rows](https://mobbin.com/screens/099fe17e-4d8f-4f6f-a386-79dea429b132), [Amazon](https://mobbin.com/screens/b4bc7774-222a-4387-84e0-cecc3c2cd765), [Instacart](https://mobbin.com/screens/5538d061-5a90-4f22-92a1-1b5d7f731c0f) | Adopted: a separate block with a heading and a text label (Tripadvisor, GoDaddy). Rejected: Amazon and Instacart's tiny grey "Sponsored" under the card, which is the "disguised advertisement" pattern; ours is a bordered text pill on the image plus a dashed, headed block and an explanation link. |
