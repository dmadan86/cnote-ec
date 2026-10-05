# Freight estimator

Status: built, on by default (`FREIGHT_ESTIMATOR_ENABLED`, set `false` to switch off). Package: `@cnote/logistics`.

Non-goal (CLAUDE.md): owning logistics. This feature never books a shipment, never holds a carrier account on a seller's behalf and never
promises a price. Every figure is an **estimate** and is labelled "the final freight is quoted by the seller". Before this, a quote carried a
seller-typed delivery charge or an unknown freight (`packages/negotiation/src/terms.ts`) and the buyer had no way to size it.

## What ships

| Surface | Behaviour |
| --- | --- |
| Buyer PDP (`apps/web`) | "Estimate freight to PIN ..." panel (`features/pdp/freight-estimate.tsx`). Prefills the PIN from the Deliver-to cookie, quantity from the MOQ. Shows a low-high range before GST, GST on freight, mode, transit days, chargeable weight, the assumptions used, and a landed-cost breakdown (goods + freight + GST on freight). The disclaimer is visible before and after a result. |
| Public web route | `GET /api/freight/estimate?listingId&quantity&pincode`. Per-IP rate limit (30/min, fails closed, `clientIp()`), `Cache-Control: private`. Never returns the seller's PIN. |
| Public REST API | `GET /v1/listings/{id}/freight-estimate?quantity&pincode` (scope `catalogue:read`, extra 60/min per key), in `docs/api/openapi.json`. |
| Seller quote form | "Suggest freight" fills the delivery-charge input from the estimator using the buyer's delivery PIN, the typed quantity and the seller's own listing weight. The seller can overwrite it. |
| Buyer quote compare | New "Landed cost (est.)" column/row per supplier: goods + GST + freight, where freight is the seller's stated charge, otherwise our estimate range. Each assumption is written out. |
| Seller listing form + bulk | Optional packed weight (g) and pack size (cm) per unit; bulk columns `unit_weight_g`, `unit_length_cm`, `unit_width_cm`, `unit_height_cm`. |
| Admin | `/freight` (privilege `logistics.manage`): active card, lane tester, JSON editor that saves a **new version**, activate/rollback, reset to the built-in default. Every mutation goes through `audited()`. |

## Architecture

`@cnote/logistics` (deps: `catalogue`, `core`, `db`, `identity`, `prices`, `security`; see `scripts/check-boundaries.ts`).

* **Port**: `FreightRateProvider { id; estimate(req): Promise<FreightEstimate | null> }`. `estimateFreight()` validates input, asks the
  provider and, on `null` or an error, falls back to the rate card (reported as the `provider_fallback` assumption). It never throws for "no live rate".
* **Heuristic provider (default, deterministic, offline, used in CI)**:
  1. PIN -> state with the one India Post table in `@cnote/prices` (`stateFromPincode`; also what buyer addresses use). No second table.
  2. Zone: `local` (same 3-digit sorting district), `intra_state`, `metro` (both ends in the eight metro lanes), `regional` (same postal zone, first PIN digit),
     `national`, `special` (North-East, J&K, Ladakh, islands; wins over metro/regional). Unknown origin degrades to `national` and is flagged.
  3. Weights: actual = quantity x unit weight (default per-unit weight on the card when the listing has none, flagged); volumetric = L x W x H / divisor
     (5000 cm3/kg for courier, 4000 for part-truck), chargeable = max of the two.
  4. Mode by chargeable weight (all thresholds on the card): <= 30 kg courier **parcel**, <= 3 t part-truck **LTL**, above that **FTL** (smallest vehicle that fits,
     several of the largest when needed).
  5. Price: parcel = first weight slab >= chargeable weight, per zone; LTL = max(min charge, kg x rate); FTL = vehicle flat rate per zone.
  6. + fuel surcharge (12%), range = -15% / +25% around that, GST 18% on freight shown separately, transit-day range per mode and zone.
* **Rate card is data**: table `freight_rate_cards` (versioned JSON, one active row, none = `DEFAULT_RATE_CARD`), validated by zod on write and read, cached
  60 s in Redis. Editing = new version; rollback = re-activate. All in paise and kg. Seed/default numbers are indicative public-benchmark style, not carrier quotes.
* **Live adapters** (`FREIGHT_PROVIDER=shiprocket|delhivery`):
  * Shiprocket: `POST /auth/login` (token cached 8 days, refreshed on 401) then `GET /courier/serviceability/?pickup_postcode&delivery_postcode&weight&cod=0`;
    range = cheapest to dearest serviceable courier's `freight_charge`, transit from `estimated_delivery_days`.
  * Delhivery: `GET /api/kinko/v1/invoice/charges/.json?md=S&ss=Delivered&o_pin&d_pin&cgm&pt=Pre-paid` with `Authorization: Token ...`; one price, widened
    -5% / +20% into a range.
  * Both: `assertPublicHttpTarget` + `pinnedFetch` (SSRF-safe, DNS-pinned), 4 s timeout, 6 h `cached()` per lane and weight band, credentials only from env.
    They price **courier parcels only**; heavy (LTL/FTL) shipments and any failure use the rate card. A live provider without credentials refuses to boot in
    production (`validateSecrets`) and degrades to the card in dev. Tests inject a stub HTTP client; no test touches the network.
* **Where catalogue fits**: `@cnote/catalogue` owns the shipping facts. They ride the existing trade-info block (`TradeInfo.unitWeightGrams`, `unitLengthMm`, ...), so they are in the
  version snapshot, the history diff and the LIVE projection with no live-db migration. `getSellerShippingFacts(sellerId, categorySlug)` gives the quote paths a weight when the
  RFQ has no listing.
* **Money**: integer paise end to end. No new events, no new personal data (a PIN the visitor typed is not stored), no new cookie or storage key (the Deliver-to cookie is the existing
  `cnote_pincode`, strictly necessary), so no consent registry or policy-version change.

## Decisions

1. **New package, not a catalogue/enquiry feature.** Freight is its own concern with its own table and provider port; it depends on catalogue/identity read APIs but neither depends on it.
   It depends on `@cnote/prices` instead of duplicating the PIN table (core-and-db-only was the aim; reuse of the single PIN source won). If the PIN table ever moves to core, this edge disappears.
2. **Estimate, never booking.** No label purchase, no pickup request, no carrier webhook. The quote's delivery charge stays the seller's number.
3. **GST on goods in the compare column.** A quote carries a flag (`gstIncluded`), not a rate. When a seller says "GST extra" we add an **assumed 18%** and say so in words; when it is not stated we add nothing and say that.
   A stated delivery charge is used as given (GST added to it only when the seller said GST is extra).
4. **PDP product GST is not added.** The catalogue has no HSN-to-rate config (see `trade-info.tsx`); the panel says product GST is excluded rather than invent a rate.
5. **Ex-works / buyer pickup quotes get no freight estimate** (0 freight), consistent with `structuredComparisonTerms`.
6. **Seller PIN privacy.** The seller's origin PIN is read server-side from the trust profile and never returned; only state/zone-level output leaves the server.
7. **Fail closed on the public route.** Live carrier lookups cost money, so the rate limiter fails closed (503) like the other paid routes.
8. **Enabled by default.** Read-only, estimate-only, deterministic with no credentials. Kill switch: `FREIGHT_ESTIMATOR_ENABLED=false`.
9. **Coarse locality.** "Local" is a same-sorting-district proxy, not a distance. A real distance model is a later improvement (the card shape already allows more zones).

## Design research (Mobbin)

Adopted patterns:
* Etsy shipping calculator, two PIN/ZIP inputs plus weight/size fields then a clear result region: https://mobbin.com/screens/04c76257-11ff-4640-b0c2-95d8b77d87d1
  -> labelled PIN + quantity fields, explicit submit (no auto-fetch on every keystroke, which would burn carrier calls).
* PayPal shipping rates, each option shows delivery time next to price: https://mobbin.com/screens/cf7c3b53-f0aa-4e89-8c5e-2a407982c914
  -> mode and transit days sit with the range, in text.
* Urban Outfitters / Squarespace order summaries, itemised rows then a total: https://mobbin.com/screens/94a1586c-cc3f-4a47-ac0e-4d3cfca9bb9f ,
  https://mobbin.com/screens/74fdbbc4-e844-4598-9c8c-9f2a0b462a94
  -> landed-cost breakdown (goods, freight, GST on freight, total) as a definition list with a ruled total.
* Shopify rate calculator, "enter the details to see rates" empty state: https://mobbin.com/screens/3e080bcc-c77d-4953-ab60-7cbaf169e0b7
  -> the idle state shows the form and the disclaimer only.

## Accessibility (buyer web, WCAG 2.2 AA)

Real `<label>` per input, errors via `Field` (`aria-describedby`), results in a polite live region, `<details>` for assumptions (keyboard native), 44px targets,
estimate label as text not colour, no motion. Strings in `apps/web/messages/<locale>.freight.json` for all 8 locales (en and hi enabled; parity-tested). Axe + keyboard:
`e2e/a11y/freight.spec.ts` (en/hi, desktop + mobile). The seller app has the `freight` namespace in all 8 locales.

## Tests

`packages/logistics/test`: zones, deterministic pricing, volumetric weight, mode switch and multi-vehicle, rate-card validation, DB store (versions, rollback, reset, estimator picks the active card),
adapters with a stub HTTP client (range mapping, bearer/token headers, fallback, no calls for heavy lanes, production credential refusal), landed-cost maths, listing/compare orchestration.
Also: catalogue DB round-trip of weight/dims, bulk validation, seller form parsing, web panel/compare/route, `validateSecrets`.

## Not done / follow-ups

* No REST write of shipping dims (the API's listing write schema does not expose trade info today); dims are read-only in `/v1/listings` via `trade`.
* No per-category weight defaults (the card has one default); category-specific defaults are data, can be added to the card.
* The compare column does not mark a "best landed" badge (the existing `Best` marks stay on quoted figures).
* Real distance (lat/long from PIN centroids) would replace the zone proxy.
* Carrier-specific B2B/LTL APIs (Delhivery B2B, Shiprocket Cargo) are not integrated; heavy lanes use the rate card.
