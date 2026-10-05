# Product variants and stock / availability

Per ADR-033 (listing versioning + live DB), ADR-007 (event log, data model), ADR-009/024 (ranking never depends on plan or spend),
ADR-004 (Bharat-native UX), ADR-011 (no vertical hardcoded), ADR-028 (outbox), ADR-032 (public API).

## What it adds

- **Availability on every listing**: `in_stock | made_to_order | out_of_stock`, optional `availableQty`, a lead time (reuses `trade.leadTimeDays`, required for made-to-order), `stockUpdatedAt`.
- **Variants**: 0..100 per listing. Each has its own SKU, one value per category axis, optional price, quantity-tier and MOQ overrides, its own stock state and lead time, and an optional image.
- **Axes are data**: `Category.attributeSchema.variantAxes = [{ key, label, options? }]` (max 4; `options` = closed list, otherwise free text). A category without axes cannot have variants. The seed gives a few demo categories axes; real verticals add theirs through `upsertCategories` (the vertical playbook checklist has an item for it).
- **Buyer**: accessible variant selector on the PDP, availability badges, "in stock only" filter and a variant facet in search.
- **Alerts**: "back in stock" fires on a real availability transition; the "listing is live again" path is renamed (see buyer-retention.md).

## Decisions

1. **Structure is content, stock is operational.** Variant structure (sku, axis values, price, tiers, MOQ, image) is frozen in the version snapshot, diffed (`variants.<sku>` entries), screened by moderation (variant SKUs and axis values are part of `canonicalText`, so also of the embedding) and published by the publisher. Stock (availability, quantity, lead time) is a fact about the seller's warehouse and must take effect in seconds, so it never waits for review: it is written to the working copy and converged into LIVE immediately. Stock-only edits do not create a version (a following submit still says "nothing has changed").
2. **Publish overlays CURRENT stock.** The snapshot also records stock at submit time, but only as a fallback (a variant deleted after submission). `buildProjection` overlays the working copy's current stock, and the publish transaction re-reads it under the listing row lock, so a toggle that commits while a version is being built is not overwritten.
3. **Effective availability** = the listing's own flag when it has no variants, otherwise the best state across its variants (a listing is in stock while any variant can ship). It is stored on the LIVE row (`availability`) and is what search filters and alerts see.
4. **LIVE is written inside the authoring transaction before it commits** (same order as the publisher), under `SELECT ... FOR UPDATE` on the listing row, so stock writers and the publisher serialise. A failed commit can only leave LIVE ahead; the hourly `reconcileLive` calls `reprojectStock` (no event) and heals it.
5. **Lead time** stays `Listing.leadTimeDays` / `trade.leadTimeDays` (already versioned content). The stock fast path may set it together with a made-to-order switch and then writes it to the LIVE trade info as well; a normal `updateListing` of the trade info remains a moderated change. A variant may carry its own lead time; otherwise it uses the listing's.
6. **Quantity is informational.** The platform never decrements it (Phase 1 has no inventory). Consistency rules: `out_of_stock` cannot have quantity > 0; `in_stock` cannot have quantity 0; switching state without an explicit quantity clears an inconsistent stored one so a one-click toggle is never refused.
7. **Defaults.** Existing listings become `in_stock` with `stockUpdatedAt = null` (UI shows "updated" only when set).
8. **Search semantics.** "In stock only" means effective availability `in_stock` (made-to-order does not count). Variant filters are matched at listing level: OR within an axis, AND across axes (`live_listings.variant_values text[]`, GIN). Variant facet counts ignore the variant filters themselves and apply all others, identically on Postgres and OpenSearch. Both are filters only; `sortOrganic` still takes relevance, trust, price, recency, and a property test proves stock facts never change the order and that filtering keeps survivors' relative order. The price facet/filter uses the listing's base price, not variant overrides.
9. **Category change** is refused while the listing's variants do not fit the new category's axes.
10. **Variant identity** is a stable UUID; `setListingVariants` matches input by `id`, then `sku`, so ids survive edits and SKU swaps work.

## Data model

- `listings`: `availability` (enum `availability_status`), `available_qty`, `stock_updated_at`.
- `listing_variants` (owned by catalogue, `ON DELETE CASCADE`): `sku` unique per listing, `axis_values` JSON, `price_paise` BigInt, `price_tiers` JSON (same model as listing tiers, validated against the variant MOQ else the listing's), `moq`, stock fields, `lead_time_days`, `image_id`, `sort_order`.
- `VersionSnapshot` (all optional, old snapshots parse): `availability`, `availableQty`, `variantAxes` (`{key,label}` frozen), `variants`.
- `live_listings` (live-db migration `listing_variants_stock`): `availability`, `available_qty`, `stock_updated_at`, `variant_axes`, `variants` (JSONB), `variant_values` (GIN). `ListingView` gains `availability`, `ownAvailability` (seller views), `availableQty`, `stockUpdatedAt`, `variantAxes`, `variants`, `imageIds` (LIVE views; lets a variant's `imageId` pick its image).
- `effectiveVariantTerms(listing, variant)` is the one place that resolves a variant's price/tiers/MOQ/lead time against the listing (own tiers win; own price without tiers is a flat price).

## Events (ADR-007, versioned)

- `ListingAvailabilityChanged` v1 `{ listingId, sellerBusinessId, fromAvailability, toAvailability, availableQty, variantId }`, emitted in the writer's transaction when the EFFECTIVE availability changes: stock fast path, variant matrix save, bulk/API stock, and a publish that carries a different stock state. Consumers: alerts (back in stock), search indexer (OpenSearch resync), cache worker (soft purge of listing, rails, search).
- `BuyerAlertTriggered` v2: new `alertType: "listing_relisted"` and optional `availability`.

## API surface (catalogue)

`updateListingStock`, `setListingVariants`, `listingVariantsForSeller`, `reprojectStock`, `categoryAxes`, `normaliseVariants`, `effectiveVariantTerms`, availability helpers; `createListing`/`updateListing` accept `availability`/`availableQty` (existing listings route them through the fast path).

## Operations

- **OpenSearch**: the index mapping is `dynamic: strict` and gained `availability` and `variantValues`. Run the reindex (`reindexAll` builds `listings_v<N+1>` and swaps the alias) BEFORE the new indexer writes to an existing cluster. The Postgres backend needs nothing.
- Run both migrations (authoring + live-db). The LIVE row of a listing published before this change has `availability = in_stock` and no variants until it is next published or `reconcileLive` runs.
- Quantity-only edits emit no event, so the web tier sees them by TTL; flips of the effective state are purged immediately.

## Not done / follow-ups

- Variant-level search hits (a hit is always the listing).
- Per-variant price in the price facet/filter and in sort.
- Inventory decrementing, reservations, low-stock alerts (Phase 2 territory).

## Surfaces

### Buyer web (WCAG 2.2 AA)
- PDP variant selector: one fieldset + legend per axis, real radios, stock stated in text on each option ("Out of stock", "Made to order"); a colour is its name, never a colour-only swatch. Selection lives in the URL (`?v=<sku>`), updates price, tiers, MOQ, lead time, availability and gallery image, and is announced through a polite live region. No variant is preselected: base terms show with a note until one is chosen. Choosing a value that does not combine with the other picks adopts the first variant offering it. The estimate uses `effectiveVariantTerms`; the RFQ link carries `variant` (SKU) and `vlabel`, and `/rfq/new` adds a "Variant: ..." line to the requirement. Out of stock never disables asking for a quote.
- Availability badge (text + icon) on the PDP and product cards; "updated <date>" when `stockUpdatedAt` is set.
- Search: "In stock only" checkbox and a facet group per variant axis (counts), in the URL like other filters, kept by saved searches. Messages are in `<locale>.pdp.json` / filters for all 8 locales (bn, gu, kn, mr, ta, te are machine-drafted: need native review). Axe spec: `e2e/a11y/pdp-variants.spec.ts` (written, run by the lead).
- Mobbin: filter sidebar with counts [Klarna](https://mobbin.com/screens/2ff7fdaf-9702-4d37-9d3a-72eb63cf463c), [H&M](https://mobbin.com/screens/e897be7a-d332-49f5-8df1-f0fbaeb617f7) (colour as text + count; dot only decorative), removable chips [Pinterest](https://mobbin.com/screens/45560b08-b73e-4f7e-8a82-878c035ddd68), plain in-stock checkbox row [Amazon](https://mobbin.com/screens/8f53c293-f83c-4a15-a34d-429aecebc19d). Not adopted: colour-only swatch grids (WCAG 1.4.1). The product-page variant query timed out on Mobbin.

### Seller app (8 locales, namespace `stock`)
- Listing editor: Availability section (instant, says so) and a variant editor as one card per variant (phone friendly): SKU, one input per axis (select when the axis has options), price/MOQ/tier overrides, availability, qty, lead time, image; "generate combinations"; cap 100. "Save variants" edits the working copy (then Submit for review); "Update stock now" uses the fast path.
- Listings table: availability badge and quick inline status select (asks for the lead time for made-to-order, reverts with an error, aria-live); listings with variants show "N variants" and a link.
- Mobbin: availability chip + inline select [Square item library](https://mobbin.com/screens/78f2c018-e2c9-440c-8b5c-e631b2539163), [DoorDash menu manager](https://mobbin.com/screens/cfb1f6b5-ef6e-4ddd-8526-bcab55408b8e); variant rows [Square add variations](https://mobbin.com/screens/74c059b4-9bb1-48d3-ab03-3a5917e058f6); parent/child "N variations" [Square bulk edit](https://mobbin.com/screens/43d138cb-1bed-4cbb-b35a-0d6e613c4945), [Shopify inventory](https://mobbin.com/screens/d9deb551-88bf-4c93-91b3-43ef6659ccef); unsaved-changes cue [Shopify bulk editor](https://mobbin.com/screens/e4e3705d-a3fb-4247-b1d6-dfdb594d8592). Not adopted: spreadsheet grid, drag handles.

### Bulk (`@cnote/bulk`)
- Product-row columns `availability` (aliases such as "in stock", "mto", "sold out"), `available_qty`, `lead_time_days`; stock on an existing listing goes through `updateListingStock` (no new version); made-to-order needs a lead time.
- Variant rows: a row with `variant_sku` set (its `sku` is the product's) with one `variant:<axis>` column per category axis plus price_rupees, moq, availability, available_qty, lead_time_days. A product's variant rows are its full set (max 100; omitted ones are deleted; ids, tiers and images of kept ones are preserved); any error in a product's variant rows applies none of them. Export round-trips. Variant tiers and images are edited in the listing editor.

### Public API / MCP
- Listing schemas carry `availability`, `availableQty`, `stockUpdatedAt`, `variantAxes`, `variants`; category `attributeSchema.variantAxes`. `GET /v1/search?in_stock=true&variant=size:m,colour:red` returns `variant` facets. `PATCH /v1/seller/listings/{id}/stock` and `PUT /v1/seller/listings/{id}/variants` (scope `listings:write`). MCP: `search_products` gains `inStock`/`variant`; new `update_listing_stock`, `set_listing_variants`. `docs/api/openapi.json` regenerated, `docs/api/README.md` updated.
