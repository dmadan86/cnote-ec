# Promotions implementation notes (ADR-025)

Companion to `promotions-and-sponsored.md`. Covers what shipped in `@cnote/promotions`, the honesty guarantees and where each is enforced, integration points the lead wires, and the Mobbin references consulted for the screens. Honesty rules win over any pattern.

## Honesty guarantees and where they live

| Guarantee | Enforced in |
|---|---|
| Strike-through is the platform-computed lowest price of the preceding 30 days | `catalogue/src/price-history.ts` (`referencePrice`, `lowestInWindow`), used at activation and again at read time |
| Under 30 days of history: price only, no "was" price, no percentage | `referencePrice` returns null; `shownReference()` and `OfferPanel` |
| A seller cannot type a reference or "original" price | `offerInputSchema` has no such field (test asserts stripped) |
| Raising a price before a sale cannot inflate the discount | Reference is a minimum over the window; validated against `reference ?? base` |
| Percent is rounded down, shown only when reference > offer price | `discountBpsFrom`, `percentOff` |
| Shown reference never exceeds the true 30-day low | `shownReference = min(reference at activation, reference now)` |
| Offers really end; no fake urgency | Expiry job, read re-checks `endsAt`, absolute end date on the page, no countdown or scarcity copy (web test greps for it) |
| Timed offers: max 30 days, 14-day cooldown, 3% floor, over 50% or below floor held for staff | `assessOffer`, `createOffer` (advisory-locked) |
| Offers must be honoured | Buyer report, staff decision, `OfferHonourDecided` (trust signal), auto-pause after 3 upheld in 90 days |
| Editorial promotions never sold; two-person rule | `promotions.ts` has no billing import; `approvePromotion` refuses `approvedBy === createdBy` |
| No enumeration of coupon codes | One generic "This code is not valid." message, rate limits per business and IP |
| No double redemption | `SELECT ... FOR UPDATE` on the coupon row, unique `(coupon, business, checkoutRef)`, per-business and per-GSTIN limits |

## Integration (lead)

- Register the worker: `worker` from `@cnote/promotions` (handlers, three jobs).
- Billing: `setCouponPort(couponPort)` with `couponPort` from `@cnote/promotions`. `quoteCoupon(code, { businessId, planCode?, amountPaise })` returns `{ couponId, discountPaise, creditsBonus, terms }` or throws `DomainError` ("validation" with the generic message, "rate_limited", "forbidden" for tier). `redeemCoupon(couponId, { businessId, paymentOrderId })` is idempotent on `paymentOrderId`; call `voidRedemption(id, reason)` for failed payments.
- GSTIN lookup: `setGstinLookup(fn)` once identity exposes a business GSTIN (enables one-per-GSTIN and GSTIN ring detection).
- Identity: handle `OfferHonourDecided { upheld: true }` as a small negative trust signal.
- Referral signup: call `applyReferralCode({ refereeBusinessId, code })` after `createBusiness` when `?ref=` is present on onboarding.
- Nav (seller): `/offers`, `/referrals`.

## Mobbin references

Consulted with output destination "code" (task: honest promotions, seller offers and referral screens for an Indian B2B marketplace).

| Screen | Reference | Adopted | Deliberately not adopted |
|---|---|---|---|
| Home hero banner | [Selfridges](https://mobbin.com/sites/sections/3cf259c8-a1fa-4c01-893d-8cf109248e16), [re_](https://mobbin.com/sites/sections/1a9b76b3-bdeb-4a73-89a3-85218ef59f90), [Seed](https://mobbin.com/sites/sections/0f2a25b1-dca4-4384-85a9-497d3f164544) | Split layout (copy left, image right), one clear CTA, thin announcement strip above the header area | "Limited time" tags, rotating carousels, discount headlines without a real comparison |
| Collection rail | [Glossier](https://mobbin.com/sites/sections/d56c79d5-584b-415c-8e27-316448eccb2f) | Curated grid under a short headline | Full-bleed promo tiles that hide prices |
| PDP price and badge | [H&M](https://mobbin.com/screens/712baa47-6362-4975-a62e-0018d9d2f799), [Etsy](https://mobbin.com/screens/6e8d5e11-bf80-482a-8f64-cb5d9e8f3008), [Hers](https://mobbin.com/screens/460f43c8-4009-40ef-a09f-cc37eef69f5a) | Percent chip beside a struck price, savings line under the price | "-69%" against an undefined "was" price, "views in the last 24 hours", "limited time sale" urgency, red price. Ours names the reference ("Lowest price in the last 30 days") and shows an absolute end date |
| Volume tiers | [Elicit](https://mobbin.com/screens/9acedf1e-4ea2-4ebb-b50f-e4525b3e9cdf), [Stripe pricing table](https://mobbin.com/screens/4dfd11b4-eaa2-4ebb-b50f-e4525b3e9cdf) | Plain comparison table with row and column headers, add/remove tier rows in the seller form | Highlighted "best value" column |
| Referral page | [Gusto](https://mobbin.com/screens/38eebe7a-5f58-4943-8868-fbd5e8be630f), [Wise](https://mobbin.com/screens/47a9d37b-a165-4655-b26b-81d3d6e3da55), [Peerlist](https://mobbin.com/screens/fbb48b34-ed9f-4a56-854f-cec590d72fb7), [Wellfound](https://mobbin.com/screens/8ee0b3e2-1a62-4eee-a16b-a414858f99a6) | Copy-link field, three-step "How it works", status list with reasons, stat row | Escalating or expiring bonuses ("bigger end-of-year bonus, ends Jan 31"), address-book and email invites (DPDP) |

No branding was copied. Colours and type come from `@cnote/ui` tokens (DESIGN.md).
