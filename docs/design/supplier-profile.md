# Supplier trust evidence, profile and compare

Per ADR-003 (badges reflect the real tier, never payment), ADR-002 (response and refund promises) and ADR-009 (ranking is not paid tier).

## Read model

One public aggregate per seller, `loadSupplierTrust(id)` in `apps/web/src/features/supplier/data.ts`, joined from the module that owns each fact (ADR-006: no module reads another's tables).

| Fact | Owner | Function |
| --- | --- | --- |
| Checks passed + dates, masked GSTIN, member since | `@cnote/identity` | `getVerificationEvidence` |
| Median first response, accept rate (90 days) | `@cnote/enquiry` | `getSupplierResponseStats` |
| Approved review aggregate and list | `@cnote/reviews` | `getSellerRatingSummaries`, `listApprovedSellerReviews` |
| Live listings | `@cnote/catalogue` | `listPublicSellerListings` |
| Live storefront slug | `@cnote/storefront` | `getLiveStorefrontSlugs` |

Rules baked into the functions and covered by tests:

- Evidence is derived from `VerificationRecord` rows (newest per kind wins, so an expired audit is not shown as passed), the business's own names and members' phone verification. Nothing commercial is an input.
- The GSTIN is masked to state code + last 4 characters; legal names are only compared (name-match check), never returned.
- Response numbers need at least 5 resolved offers in the last 90 days; below that the API returns no numbers and the UI says "New supplier".
- Ratings and JSON-LD `aggregateRating` exist only when there is at least one approved review.
- Caching: Redis per seller inside each module (`cachedManyTagged`), then the Next data cache in the web app, so `/manufacturers/[id]` and the PDP stay static/ISR (revalidate 300).

## Surfaces

- **Seller card** (`features/supplier/seller-card.tsx`, PDP): tier badge, "What's verified" disclosure (button with `aria-expanded`, inline panel, rows state "Passed <date>" or "Not completed" in text), response time, accept rate, years, rating, "View profile" and a `contact` slot for the existing unlock flow.
- **Profile** `/manufacturers/[id]`: header with tier, checks summary, metrics and actions (Request quote with `?seller=`, Contact, Share, Report to `/report?url=`, storefront link). ARIA tabs (About, Products with category chips, Reviews, Verification) with the active tab in the URL hash. All panels are server-rendered, inactive ones are `hidden`. About omits capacity and certifications because they are not modelled.
- **Compare**: supplier rows (verification, location, response time, accept rate, rating, years) and optional price tiers (read defensively, row hidden when no listing has tiers). "Highlight differences" is a switch; differing rows also carry a visible "Differs" tag so the highlight is never colour-only.

## Mobbin references

Searches run: "supplier profile page B2B with verification badges and response rate" and "seller card with trust badges, rating and contact button". Results were mostly merchant dashboards, so only a few patterns were adopted:

- Klaviyo review overview ([screen](https://mobbin.com/screens/5d904a92-c8c4-441d-98fb-520119df8266)): big average with per-star histogram rows, used in the Reviews tab.
- GetYourGuide checklist with icons ([screen](https://mobbin.com/screens/3e9f4aae-add7-4646-82e8-1f39eea9ec32)): icon + text rows for guarantees, used for the verification checklist (with explicit "Passed"/"Not completed" text).
- DoorDash Merchant ratings ([screen](https://mobbin.com/screens/9e6426ba-199d-47c7-b972-5a336c00e22d)): responsiveness shown as a plain metric next to ratings.
- Klaviyo profile with tabs ([screen](https://mobbin.com/screens/7a9377d8-6bc4-4746-bcde-a55418e9f376)): a tabbed detail page under a header with actions.
