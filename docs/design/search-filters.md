# Search filters, facets and sort

Scope: `packages/search` (contract, both backends) and the buyer web `/search` (products + manufacturers tabs) and `/c/[slug]`.
Governing rules: ADR-009 (ranking = relevance x trust, never paid tier alone, sponsored always labelled), ADR-008 (matching < 2 s),
ADR-004 (vernacular, mobile first), WCAG 2.2 AA on the buyer web.

## Design research (Mobbin)

Query: "B2B marketplace search results with filter sidebar and sort" (web).

- [Faire](https://mobbin.com/screens/fd230435-b822-4dc0-938a-0c7103e6b119): left sidebar of grouped facets with counts, "2 filters applied" + "Clear all" at its top, a "Show more" per group, sort select top right. Adopted: grouped facet fieldsets with counts, truncation with "Show more", a visible applied count and Clear all.
- [Snowflake Marketplace](https://mobbin.com/screens/7ac9d292-c38d-4b0d-8ffc-12edbcc64d35): removable applied-filter chip with "Clear all" above a result count line, sort at the right of the count. Adopted: chip row (each chip removes only itself) between toolbar and results.
- [Relevance AI](https://mobbin.com/screens/27ac57af-bb44-4f03-8365-f0dc44d41719) and [Mercor](https://mobbin.com/screens/4b4ad7f3-454a-4b5e-b82b-ca4eeb95fdde): compact "Filter" and sort controls in one toolbar row. Adopted for the mobile toolbar (Filters button + sort side by side).

Not adopted: auto-applying dropdown filters (changes context on input, WCAG 3.2.2); we use an explicit Apply button.

## Contract (`@cnote/search`)

`searchListings({ q, categorySlug?, filters?, sort?, limit?, cursor? })`

| Filter | Field | Semantics |
|---|---|---|
| Verification | `minTier` 0..3 | seller tier >= N (T0 phone, T1 GST, T2 KYC, T3 audited) |
| Seller place | `states[]`, `cities[]` | case-insensitive, any-of |
| Price | `priceMinPaise`, `priceMaxPaise` | inclusive; excludes "price on request" |
| MOQ | `maxMoq` | MOQ <= N; listings with no stated MOQ always qualify |
| Has price | `hasPrice` | excludes "price on request" |
| Category | `categories[]` (slugs) | each also matches its subcategories (resolved to ids in `search.ts`) |

`filters.ts` holds the pure pieces (`normaliseFilters`, `matchesFilters`, `computeFacets`, `sortOrganic`) shared by both backends and the web.

### Backends

- **Postgres (default):** `catalogue.retrieveListings` pushes the filters into both the FTS and the pgvector SQL (live_listings already carries the seller snapshot: tier, state, city, price, MOQ). Facets: `retrieveFacetRows` returns the unfiltered lexical match pool (capped at 2000 rows) and `computeFacets` tallies it in memory.
- **OpenSearch:** filters become `post_filter` clauses (and the kNN `filter`); every facet is a filter aggregation holding all other dimensions' filters. `parseFacets` reads both plain and filter-wrapped aggregations.
- Both give **disjunctive** counts: a facet ignores its own dimension's filter, so ticking a tier does not hide the other tiers. Facets: tier (exact tier counts; the UI sums "or higher"), state, city, category, price buckets (< 1k, 1k-10k, 10k-1L, >= 1L rupees).
- `search.ts` also re-checks tier/state/city/price/MOQ against the live listing and the identity profile (a backstop for stale OpenSearch docs).
- Facets are first page only; Postgres facets are lexical-match only, so for purely semantic hits they can undercount. Documented trade-off.

### Sort

`relevance` (default, relevance x trust x location boost), `price_asc`, `price_desc` (price on request always last), `newest` (first published), `trust` (verification tier, then trust score). Non-relevance sorts order a wider candidate pool (>= 120) and then cut to the page. All sorts end on the listing id, so order is total and deterministic.

**Trust invariant.** `sortOrganic` takes `OrganicItem` (score, price, published date, verification tier, trust score). There is no plan or ad-spend field. `filters.props.test.ts` proves, for every sort, that attaching arbitrary plan / ad-spend / sponsored values changes no order, and `search-filters-flow.test.ts` repeats it through the full pipeline. Sponsored slots stay outside the cached organic order and are merged by `@cnote/ads` as before.

### Location

Seller location data is state and city only (no delivery areas, no seller pincode on the live row). "Deliver to <pincode>" is therefore implemented as "seller located in the pincode's state" (`features/search/geo.ts`, India Post circles), and the UI says so ("We match suppliers located in {state}. Delivery areas are not listed yet."). Pincode-level delivery needs seller service-area data first.

## Web UI

- URL is the single source of truth (`features/search/filter-state.ts`): `tier`, `state`, `city`, `category` (repeatable), `pmin`/`pmax` (rupees), `moq`, `priced=1`, `deliver=<pincode>`, `sort`. Defaults are omitted, so URLs stay short and shareable; the back button works because every change is a navigation.
- Desktop: sticky-less sidebar (`<aside aria-label="Filters">`). Mobile: "Filters (n)" button opening a native `<dialog>` (`showModal`: focus trap, Esc, focus return). The same GET form is rendered twice with distinct id prefixes.
- Sort: select + explicit "Apply sort" button; the note "Sponsored listings are always labelled and never change this order." sits under it.
- Applied filters: chips are links that remove just that filter; "Clear all".
- Pincode: the `cnote_pincode` cookie only pre-fills the label of an unchecked, opt-in checkbox ("Only suppliers who deliver to 560001"). Ticking it puts `deliver=560001` in the URL (visible chip). Never silent, and the pages never read cookies on the server (the localised-routes guard test stays valid).
- `/c/[slug]` stays ISR: it takes no query string. Its filter form and sort submit to `/search?category=<slug>&...`, which renders the same sidebar in its applied state. Unfiltered facet counts are cached with the page's hits.
- Manufacturers tab: tier / state / city filters, `relevance` and `trust` sorts, computed over trust profiles with the same pure functions. Price, MOQ and category do not apply to suppliers.
- Prices use `formatINR` (Indian grouping) and `formatNumber` (en-IN digits) for every locale; copy lives in `messages/<locale>.filters.json` (8 locales; en and hi reviewed, the rest await native-speaker review per ADR-004). State names reuse the `states` catalogue.
- a11y: fieldsets with legends, every control labelled, >= 44 px targets on mobile, counts inside the label, chips named "Remove filter: ...", no auto-submit.

## Tests

`packages/search/test/filters*.test.ts`, `search-filters-flow.test.ts`; `packages/catalogue/test/retrieval-filters.db.test.ts` (live SQL); `apps/web/test/search-filters*.test.ts(x)`; `e2e/a11y/search-filters.spec.ts` (axe with the sheet open, URL/result updates, sort order, keyboard).
