# Proposed ADRs: Sponsored placements (024) and Promotions & offers (025)

**Owner:** Madan. **Version:** 0.1 proposal, 29 Sep 2026. **Appends to:** `docs/adr/ADR-v0.1.md` (numbering continues after ADR-023).
**Design detail:** `docs/design/promotions-and-sponsored.md`; schema, events and privileges: `docs/design/promotions-schema.prisma.md`.
Format follows the main ADR file: Context, Options, Decision, Rationale, Consequences, Review.

These ADRs refine, and do not supersede, ADR-005 ("ranking boost tied to trust score, not payment") and ADR-009 ("rank by relevance x trust, never by paid tier alone; sponsored slots clearly labelled"). ADR-009 permits sponsored slots but says little about how they work; ADR-024 supplies the constraints.

---

## ADR-024: Sponsored placements (paid visibility, separate from ranking)

**Status:** Proposed

**Context.** A second revenue line beyond subscriptions and leads (ADR-001, ADR-005) is desirable, and sellers in India already buy performance ads on Flipkart and Meesho (CPC, daily budgets) and Alibaba.com (P4P keyword auctions). But the platform's positioning against IndiaMART is that badges and rank follow trust, not payment (ADR-003, ADR-009): IndiaMART's TrustSEAL is available to paid subscribers only and carries higher placement and lead allocation. Regulation is tightening: the E-Commerce Rules require distinct, prominent identification of sponsored listings and a public explanation of ranking parameters, and the 2026 amendment (in force 1 Jan 2027) adds annual dark-pattern audits and a 30-day lowest-price reference for discounts. Amazon's model (quality-weighted second-price auction, labelled ads that blend into results) is the reference, and its label design and ad pricing practices are the subject of criticism and litigation. Applicability of the consumer rules to a B2B-only platform is not settled, so we build to the stricter reading.

**Options.**
1. **No ads.** Keep revenue to subscriptions and leads. Simplest; leaves money on the table and gives sellers no way to buy visibility beyond plan.
2. **Pay-to-rank inside organic results** (incumbent pattern). Highest short-term revenue; destroys the positioning and violates ADR-003/005/009.
3. **Separate, capped, labelled sponsored slots; eligibility-gated on trust and relevance; ranked by quality, priced per click.** Organic order untouched.
4. **Sponsored slots as in option 3 but sold by open bid auction from day one.** Higher yield, but needs click and conversion data we do not have, and invites bidding wars that price out MSMEs.

**Decision.** Option 3, delivered in two stages:
- **Stage A (Phase 1.5): public rate card.** Fixed CPC per category set by staff and published; sellers choose a budget, not a bid. Eligible ads are ranked by `relevance x trust` with rotation among near-ties. Manual campaign approval. Search and category surfaces only.
- **Stage B (Phase 2): CPC generalized-second-price auction** with `rank = bid x relevance x trustFactor x pCTR`, reserve prices and a max-CPC cap per category, self-serve campaigns, and product-page and home-rail surfaces. CPM brand banners and consent-based behavioural targeting are Phase 3.

Non-negotiable rules (each enforced in code and covered by a test):
1. **Organic isolation.** No ad or payment input reaches organic ranking. The organic result is computed and cached exactly as today; ads are merged afterwards into fixed slots. A test asserts organic order is identical with ads on and off.
2. **Eligibility gates.** Seller verification tier >= 1 and trust score >= a configured floor (default 60, staff-tunable, not below 50); listing published and moderation-approved with at least one approved image; category not prohibited; relevance above a floor. Failing any gate means no ad, whatever the bid. Plan tier (Free/Starter/Pro) never enters ad ranking or price.
3. **Placement and caps.** Search and category: at most 2 sponsored above organic, then 1 per 10 organic results, never more than 20% of cards on a page, none when fewer than 10 organic results, one ad per seller per page. Product page: a separate "Sponsored similar" rail of at most 2. Home: an optional separate rail (Phase 2), never inside "Trending" or "Best Selling". Never in lead matching, RFQ supplier suggestions, the manufacturers directory order, or trust badges. Empty slots collapse; unpaid content is never styled as an ad.
4. **Disclosure.** Every ad carries a "Sponsored" label (localised, not colour-only, AA contrast, not in brand or accent colours) with an explanation affordance, in a visually distinct block. A public "How ranking works" page, generated from code constants, states the organic parameters and their relative weight, the sponsored eligibility and pricing rules, and what is never for sale.
5. **Advertiser protection.** Prepaid wallet in integer paise, separate from lead credits, in the billing module's append-only ledger; GST invoice at top-up; daily budget is a hard cap and we never charge above bid or budget; automatic refund of clicks later judged invalid (72h re-score) with no ticket; paid top-ups never expire silently and are refundable to source; no auto top-up by default; pause any time, no commitment. Itemised reports show cost per enquiry and the invalid-click share.
6. **Click integrity.** Signed, single-use click tokens; duplicate, bot, self-click and burst rules; a fraud review queue.
7. **Lead independence (ADR-002).** Ads never influence matching, lead caps, intent scores or lead credits. An ad-attributed enquiry is a buyer-selected enquiry and follows existing lead rules (whether it is additionally CPC-charged is an open question, see Review).
8. **Governance.** Campaigns, ad groups, listings and keywords are staff-reviewed (`ads.review`); ads can be suspended instantly (`ads.suspend`); kill switches per surface and globally without a deploy; every action is audited.
9. **Performance.** Ad decision p95 < 30 ms from cached eligibility with no database call on the hot path; any failure or timeout returns zero ads and organic renders normally.
10. **Revenue guardrail.** Ads as a share of trailing-90-day revenue is capped (proposed 20%); exceeding it needs an explicit decision recorded in an ADR.

**Rationale.**
- Options 1 and 3 both protect the differentiator; option 3 adds revenue and gives honest sellers a way to buy visibility that they can see and measure. Option 2 is what buyers and sellers complain about on the incumbent.
- Stage A avoids an auction until we have click data and enough advertisers per category, avoids bidding wars that disadvantage MSMEs, and makes pricing public in line with ADR-005. Quality-weighted ranking (relevance x trust) means even paid slots reward the sellers the buyer would trust.
- The multiplicative quality score reuses the same `trustFactor` as organic ranking, so there is one definition of trust weighting and one disclosure.
- The strictest reading of India's disclosure and dark-pattern rules is cheap to build in from the start and costly to retrofit.

**Consequences.**
- Two new modules (`@cnote/ads`; wallet ledger inside `@cnote/billing`), a Redis-backed decision path, a click-fraud pipeline, and staff review workload. `trustFactor` moves from `search` to `identity` so both import it; `search` gains a dependency on `ads`.
- Real payment collection and GST invoicing become prerequisites (billing mocks payment capture today). The pilot uses finance-credited wallets and manual invoices for a small seller set.
- Fewer paid slots than an aggressive marketplace; revenue per search is lower by design.
- Legal review needed: applicability of consumer e-commerce rules to B2B, treatment of a prepaid wallet usable only for our own services, SAC and advance-payment GST, DPDP treatment of frequency-cap identifiers.
- New admin privileges: `ads.read`, `ads.review`, `ads.suspend`, `ads.fraud.review`, `ads.settings`. New consent purpose `ads_personalisation` only when behavioural targeting is introduced (Phase 3).

**Review.**
- Gate to Stage A live: disclosure page and label shipped; counsel sign-off; payment or manual-pilot invoicing in place.
- Gate to Stage B: 8 weeks of Stage A inside guardrails: sponsored CTR not far below organic; enquiry-to-conversation rate from ads at parity with organic; ad-related complaints below the agreed threshold; median trust of ad winners at or above the organic top-10 median.
- Roll back or tighten if buyer-trust measures fall after launch, if invalid-click share exceeds the agreed level, or if ads pass the revenue cap.
- Open: should an ad-attributed enquiry that becomes an accepted lead cost CPC plus a lead credit (proposed, transparent) or credit only.

---

## ADR-025: Promotions and offers (editorial, seller offers, coupons, referrals)

**Status:** Proposed

**Context.** The platform needs four different kinds of "promotion" that are often conflated:
- (a) **Editorial promotions**: home hero banners, curated collections ("Diwali gifting"), category spotlights run by staff.
- (b) **Seller offers**: volume-discount tiers, limited-time prices, free delivery over a MOQ.
- (c) **Coupons on subscription plans.**
- (d) **Referral credits.**

They have different owners, money flows and legal exposure. Conflating editorial and paid placement would make "curated" a paid product in disguise (CCPA lists "disguised advertisements" as a dark pattern). Discounts are regulated: the 2026 e-commerce amendment requires showing the lowest price of the preceding 30 days alongside a price reduction, and CCPA guidelines name false urgency, drip pricing, bait and switch and subscription traps. ADR-005 already bans auto-upgrade, auto-renew without confirmation and hidden pricing.

**Options.**
1. **One generic "promotions" engine** covering banners, offers and ads.
2. **Separate systems with a firewall:** editorial (`promotions`, unpaid), paid (`ads`, ADR-024), seller offers, and coupons/referrals as distinct small models.
3. **Buy a third-party promotions/CRM tool** for coupons and banners.

**Decision.** Option 2, in a new `@cnote/promotions` module (editorial, offers, coupons, referrals) that has no relationship to the ad wallet.

1. **Editorial promotions are never sold.** Staff author with `promotions.manage`; a different staff member approves with `promotions.publish` (maker-checker, same split as templates). Fixed code-defined layouts with staff-owned copy and images (alt text mandatory, images via `@cnote/media`). Time-window and audience (segment, state, language) targeting only, no behavioural targeting. Collection items are chosen on merit, must pass standard listing eligibility, and each pick records a curator's note. A seller paying for placement is an ad and belongs to ADR-024 with the label. Promotion emails are `marketing` category: consent-gated (ADR-010), preference-respecting, capped at one per person per week, unsubscribe included.
2. **Seller offers** are typed and validated (volume tiers strictly decreasing in price; timed price max 30 days with a 14-day cooldown; free delivery over a MOQ with regions). Strike-through rules: the **reference price is computed by the platform** as the lowest listing price in the preceding 30 days from an append-only price history; sellers never enter it; no reference and no percentage if history is under 30 days; percentages rounded down; countdowns use the real end time and the offer really ends; no scarcity claims; all terms (units, MOQ, validity, regions, GST treatment) shown up front. Auto-approval when rules pass; staff review when flagged (deep discount, below category floor, prior honour complaints). Offers are indicative prices the seller must honour; upheld "not honoured" reports feed trust score (ADR-003) and can suspend offer privileges. **Offers never affect organic rank** (ADR-009); they add a chip, a filter and a "Deals" page ordered by the normal relevance x trust.
3. **Coupons** (percent with cap, flat, extra lead credits, restricted ad credit) apply to the first billing period only, one per checkout, never stackable with another coupon, one per business and per GSTIN, tier >= 1 where value is material. The checkout states the discounted price and the post-discount renewal price; renewals still require explicit confirmation (ADR-005). Abuse controls: rate-limited code attempts, one generic error message, random codes for targeted campaigns, second approver for large values, redemption rows keyed idempotently. `billing.subscribe` gains an optional discount input; billing never imports promotions.
4. **Referral credits:** rewards are lead credits (90-day expiry), never cash. Reward requires a **qualifying action** (referee reaches tier >= 1 and publishes a first approved listing, or completes a first verified enquiry), a 7-day fraud hold, per-referrer quarterly cap, and self-referral and ring detection on GSTIN, phone, device, IP cluster and bank account. No address-book import and no platform-sent messages to non-users. Rejections are shown to the referrer with a reason.

**Rationale.**
- The firewall makes ADR-009 checkable: the editorial module has no code path to a wallet or price.
- A system-derived reference price removes the main source of misleading discounts and matches the new statutory definition, and because it is a minimum over 30 days, raising the price before a sale cannot inflate the "discount".
- Credits instead of cash for referrals and coupons keeps incentives aligned with real activity and lowers fraud value, and it reuses the existing append-only credit ledger with no schema change (`reason = grant`, `refType = referral | coupon`).
- Maker-checker on public-facing content and large coupons mirrors the existing template publishing controls.
- Building on our own modules keeps consent, audit and RBAC in one place; a third-party tool would need PII sharing and would not know our trust rules.

**Consequences.**
- New models (`Promotion*`, `ListingOffer`, `OfferHonourReport`, `Coupon`, `CouponRedemption`, `Referral`) and a catalogue prerequisite: `ListingPriceHistory` written on every price change.
- `search` decorates results with active offers; the offer lookup must be cached and indexed (partial index on active offers).
- New privileges: `promotions.read/manage/publish`, `offers.review`, `coupons.read/manage`, `referrals.review`. New template keys (`promo.announcement` marketing; offer, referral and ad alerts transactional).
- Coupon and referral flows need real payment collection in billing (mocked today) for paid plans.
- Sellers lose the ability to type any "original price"; some will ask for it. The answer is the published rule.
- Legal review: applicability of the 2026 rules to B2B, coupon and referral T&Cs, WhatsApp marketing opt-in policy.

**Review.**
- Ship order: editorial + offers first (Phase 1.5a), coupons and referrals with payment collection (1.5c).
- Revisit if offer honour complaints exceed the agreed rate per 1,000 offers, if referral rejection rate suggests systematic fraud, or if coupon redemptions concentrate on a small set of GSTINs.
- Review the 14-day cooldown and the 3% to 50% discount band after 60 days of data.
- Confirm with counsel before launch whether the annual dark-pattern audit and certificate (Rules 2026) applies to us, and add it to the compliance calendar (ADR-010) if so.

---

## Amendments to existing ADRs (for the DDR)

- **ADR-009:** add a cross-reference: "Sponsored placement rules are in ADR-024."
- **ADR-005:** add a cross-reference for coupons and referral credits (ADR-025), and confirm that "ranking boost tied to trust score" is unaffected by plan or ads.
- **ADR-010 checklist:** add ads and offers items: disclosure page accuracy, frequency-cap identifier retention, consent purpose `ads_personalisation` before any personalisation.
- **Appendix C open questions:** add pilot CPC rate card, ad revenue cap, and treatment of a prepaid ad wallet.
