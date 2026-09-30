# Price intelligence (ADR-022)

Anonymised category price benchmarks from quotes and escrow orders, shown to buyers during RFQ, to sellers as
competitiveness signals (premium tier) and managed by staff. Package `@cnote/prices`, schema
`packages/db/prisma/schema/prices.prisma`. Flag `PRICE_INTEL_ENABLED` (default off).

## Method

1. **Facts.** `@cnote/enquiry` exposes `listPriceFacts` (keyset-paged, read-only): every quote on a categorised enquiry, and
   escrow-settled, non-cancelled orders with a per-unit price. Facts carry category, price per unit (paise), quantity, unit,
   delivery pincode and, for distinct-counting only, the seller and buyer business ids. They never leave `@cnote/prices`
   memory and are never stored or returned.
2. **De-duplication.** An escrow order supersedes the quote it was created from.
3. **Unit normalisation.** Convertible units map to a canonical unit: kg (g, quintal, tonne), pcs (dozen, gross), m (cm, ft),
   l (ml, kl), sqm (sqft). set/pair/box/pack/roll/bag/sheet/carton/bundle/packet/bottle are comparable only with themselves.
   Anything else is skipped (and counted in the run result). Prices convert by `price / factor`, quantities by `qty * factor`.
4. **Region.** From the delivery pincode, two levels. *State / UT*: longest-prefix lookup over the India Post PIN structure
   (`src/regions-data.ts`: 2-digit sub-zone defaults, 3-digit sorting-district overrides, and 4 to 6 digit exceptions where a
   postal circle straddles a border, e.g. Udham Singh Nagar and Roorkee in Uttarakhand versus the Uttar Pradesh 244/247 districts,
   Bijnor, Daman/Diu/Silvassa, Mahe/Yanam/Karaikal, Lakshadweep). *Pincode zone*: the first three digits (`pin-560`, the sorting
   district), only for geographic PINs that are not in a border exception, so a zone never mixes states. Army Postal Service (9x) and
   malformed PINs count towards national cells only.
5. **Cells.** category x canonical unit x region (pincode zone, state or `national`) x volume tier (`t1`/`t2`/`t3` quantity bands per unit, or
   `all`). Window: trailing 90 days ending at the run; `period` is the run's month (`YYYY-MM`), recomputed nightly.
6. **Statistics.** IQR trimming (1.5 x IQR, only with at least 8 samples), then p10/p25/median/p75/p90 as weighted
   percentiles (no interpolation). Escrow samples weigh `PRICE_ESCROW_WEIGHT` (default 3), quotes 1. Source mix
   (`quoteCount`, `escrowCount`) is stored per cell.
7. **Trend.** Median vs the previous period's same cell, in basis points (within +-2% is "steady").

## k-anonymity and suppression

Every candidate cell is evaluated independently, after trimming. It is published only if **all** hold:

- at least `k` distinct sellers,
- at least `k` distinct buyers,
- no single seller contributes more than 50% of the samples (dominance rule).

`k` defaults to 5 (`PRICE_K` env, or the value staff set in the admin console, which wins; bounded to 3..100 and changes are
audited). Failed cells are not stored; the run records counts per first failing rule (`sellers`, `buyers`, `dominance`).
Cells that stop qualifying are deleted by the next run.

Zone cells are evaluated with exactly the same rules on their own samples, so a thin zone (or one dominated by a seller) simply is not
published and readers fall back to its state.

**Roll-up** happens at read time over cells that are each already k-anonymous: zone, then state, then national, first for the requested
volume band and then for all volumes (zone + band, state + band, national + band, zone + all, state + all, national + all). The most
specific published cell wins; the response says when it rolled up (`scope.rolledUp`) and names it (`scope.regionLabel`: `PIN 560xxx`, `Karnataka`, `India`). The response says when it rolled up (`scope.rolledUp`). Cells store no
business ids, only distinct counts. Sellers see only aggregates; nothing is counterparty-identifiable.

## Surfaces

- **Buyer (web):** `PriceHint` on `/rfq/new` watches the RFQ fields (category, quantity, unit, pincode) and shows the
  state-level p25 to p75 range and median per requested unit, always labelled indicative, with the sample count and trend.
  Backed by `getPublicBenchmark` (JSON-safe: aggregates only) through a rate-limited server action. WCAG 2.2 AA: labelled
  region, polite live region, meaning carried by text.
- **Seller:** `/prices`, `getSellerCompetitiveness`: for each live priced listing, below/within/above the p25 to p75 band
  (seller's state, listing MOQ as volume), % vs median and trend. Premium tier: active paid subscription; if any billing plan
  lists the feature string "Price intelligence", only those plans qualify (`PRICE_INTEL_PLAN_FEATURE`).
- **Admin:** `/prices` (`prices.manage`): k threshold, publication runs, suppression stats, manual unpublish/republish of a
  cell (unpublished cells keep refreshing numbers but are never re-published by a run), run now. All mutations are audited.

## Event and jobs

`PriceBenchmarkPublished { period, categories, cells, suppressedCells }` is emitted in the same transaction as the cell
replacement. Job `prices.nightly-benchmarks` checks every 6h and runs when no nightly run started in the last 20h.

## Design research (Mobbin)

Perplexity Finance watchlist rows (https://mobbin.com/screens/471f9aa4-b86c-4eb8-bddf-6f7a36639782): price next to a
delta pill with sign and arrow, adopted for the seller position and trend cells (glyph plus words, never colour alone).
Calendly and Descript plan tables (https://mobbin.com/screens/c3a7b2d3-de35-4e07-8a04-6e23f3b6d0a6,
https://mobbin.com/screens/a349ba1c-ba39-4c60-b4b4-da73cd6282c5): plain, captioned comparison table and a clear locked-feature
upsell for the free tier.

## Known limitations

- State comes from the India Post prefix table plus the known border exceptions; a few individual border pincodes (for example Mohali
  160055 inside the Chandigarh 160 district) can still land in the neighbouring state. Zones are three-digit sorting districts, not
  city boundaries, and small zones will mostly be suppressed. Zone, state and national cells overlap, so the theoretical differencing
  risk below is slightly larger with the extra level (k and dominance apply to each cell).
- Quotes are asking prices, not settled prices; escrow weighting only partly corrects this. Off-platform orders are excluded.
- Publishing national and regional cells together leaves a theoretical differencing risk; the k and dominance rules apply to
  each cell, and buyer-side dominance is not limited separately.
- Quantity bands are fixed per unit (code), not per category. Per-category bands would be config.
- Message catalogues for non-English locales are machine drafted and flagged for native review.
