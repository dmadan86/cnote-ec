# Performance, caching and SEO

Founder directive: fast like Amazon, cache aggressively (Redis + static), and make search SEO-friendly and accessible (WCAG 2.2 AA **and** friendly to AI/LLM crawlers). This document records the decisions, the cache/tag/TTL table and the invalidation map.

## 1. Decisions

### 1.1 ISR + client islands, not Cache Components (yet)

We evaluated `cacheComponents` (`use cache`, `cacheTag`, `cacheLife`, PPR). It is **not enabled**, for these reasons:

- It removes `export const revalidate` / `dynamic` / `fetchCache`, forces every dynamic read (cookies, `searchParams`, un-cached DB calls) to sit inside `<Suspense>`, and turns any miss into a build error. Five other teams are editing pages in `apps/web` concurrently (account, developers, media), so a global switch would break routes we do not own.
- The buyer app read cookies in the root layout (header) and inside every product card (saved / compare state). The problem to solve is that, not the caching primitive.

So the shell was made **static** and per-user state moved to **client islands**; pages then use classic ISR (`revalidate`, `generateStaticParams`) with tag-based on-demand revalidation. This gives the same result as PPR for our pages (static HTML from the CDN, personal bits streamed in after) with no framework-wide migration. Revisit `cacheComponents` when the account/seller pages have `<Suspense>` boundaries.

Per-user island architecture:

| Concern | Before | Now |
|---|---|---|
| Header (account menu, Saved/Compare counts, pincode) | server component reading cookies | static header + `HeaderActions` client island |
| Heart / compare buttons on cards | `loadSavedState()` + `readCompareIds()` per card (cookies) | `SaveIsland` / `CompareIsland` read a shared store |
| Compare tray | server component (cookie) | client `CompareTray` from the same store |
| Reviews write forms / "my review" | `currentSession()` in the section | `ReviewsUserPanel` island -> `GET /api/me/product/[id]` |
| Review sort / more | `?reviewSort=` (searchParams => dynamic) | client fetch of `GET /api/reviews/[id]` |
| Home rail tabs | `?rail=` (searchParams) | ARIA tabs over server-rendered panels |

The store (`features/user-state/store.ts`) does **one** `GET /api/me` per page load (`Cache-Control: private, no-store`, `Vary: Cookie`, `Server-Timing`). Nothing personal is ever in cacheable HTML or in a shared cache. `ensureFresh()` refreshes it before server actions because actions POST to the page URL, which bypasses the auth proxy (see 1.4).

### 1.2 Two cache tiers

1. **Redis** (`packages/core/src/redis.ts`, used inside each domain module): shared across instances.
   - `cachedTagged(key, tags, ttl, load, { staleSeconds, softTags })`: JSON envelope, stale-while-revalidate, request coalescing in-process, cross-instance lock (`SET NX`), tag registration in Redis sets, fail-open on Redis errors.
   - `cachedManyTagged(ids, ...)`: batch `MGET`, loads only the misses, never caches absent ids.
   - `invalidateTags(tags)` (**hard**: entries deleted) and `softInvalidateTags(tags)` (**soft**: entries become stale, SWR serves them once while one caller refreshes).
   - A fill that overlaps a hard invalidation never writes (per-tag invalidation timestamps), so a slow loader cannot resurrect a purged entry.
   - `getCacheStats()` (hit / miss / stale / error per key family, logged every 5 min from `instrumentation.ts`; `CACHE_LOG=1` for per-key logs).
2. **Next.js data cache + ISR** (`apps/web/src/features/search/data.ts`, `unstable_cache` with the *same tag names*): feeds the prerendered pages. Purged by `POST /api/revalidate`.

Rules that keep this correct:

- Only public, non-personal data is cached. Wishlist reads are per-user and intentionally uncached.
- **Unapproved content never enters a cache.** `getPublicListingsByIds`, `listFeaturedListings`, `listPublicSellerListings`, search and reviews filter to published + approved *before* caching; absent/unapproved ids are not cached. The legacy `getListing` / `getListingsByIds` / `listSellerListings` stay uncached (seller and admin need fresh state).
- Moderation-class events invalidate **hard** in both tiers (Next `revalidateTag(tag, { expire: 0 })` = blocking revalidate); ranking-class events are soft (stale-while-revalidate).

### 1.3 Static / ISR rendering

| Route | Rendering | Revalidate | Notes |
|---|---|---|---|
| `/` | static (ISR) | 300s (tag-driven) | Organization + WebSite/SearchAction JSON-LD |
| `/categories`, `/c/[slug]` | SSG all categories | 900s / 300s | ItemList + BreadcrumbList |
| `/p/[slugId]` | SSG top 100, rest on demand (ISR) | 300s | Product + Offer + AggregateRating + BreadcrumbList, specs `<table>`, dynamic OG image |
| `/manufacturers/[id]` | SSG top 50, rest ISR | 300s | Organization + LocalBusiness |
| `/s/[category]/[keyword]` | SSG (allow-list), rest ISR | 600s | curated landing pages, unknown keywords 404 |
| `/pricing`, `/coming-soon/*`, `/llms*.txt`, sitemaps, `robots.txt` | static | 300s-1h | |
| `/search`, `/manufacturers` (filters) | dynamic (searchParams), backed by Redis; CDN-cacheable via `Cache-Control: public, s-maxage=60..120, swr` | | `/search` is `noindex,follow` |
| `/account/**`, `/buyer/**`, `/rfq/**`, `/conversations/**`, `/wishlist`, `/compare`, auth pages | dynamic | | `Cache-Control: private, no-store`, `X-Robots-Tag: noindex` (next.config headers) |

Assets: seed placeholders `max-age=1d, swr=1w`; listing photos are content-addressed and `immutable`; uploaded photos go through `next/image` (AVIF/WebP, 30-day optimiser cache); SVG placeholders are `unoptimized`. LCP image on the product page uses `preload`; card rows use `loading=eager` + `fetchPriority=high` for the first few only. Font: `next/font` Geist, `display: swap`, latin subset, size-adjusted fallback.

### 1.4 Auth proxy scope

`proxy.ts` now matches only `/account`, `/onboarding`, `/buyer`, `/rfq`, `/conversations`, `/wishlist`, `/compare`, `/api/me/**`, `/signin`, `/signup`. Public pages skip it (no per-request work, never a `Set-Cookie` on a CDN-cacheable response). `/api/me` is matched so an expiring access token is rotated before the islands call server actions.

## 2. Cache / tag / TTL table

Redis TTL = fresh window; SWR = additional stale window.

| Key family | Function | Tags | Fresh | SWR |
|---|---|---|---|---|
| `catalogue:categories:v2` | `listCategories` (and `getCategoryBySlug/ById`) | `categories` | 300s | 1h |
| `catalogue:listing:v1:<id>` | `getPublicListing(sByIds)` | `listing:<id>` | 300s | 10m |
| `catalogue:featured:v1:<sort>:<n>` | `listFeaturedListings` | `featured`, `listing:<id>`* | 120s | 10m |
| `catalogue:seller-listings:v1:<biz>` | `listPublicSellerListings` | `seller-listings:<biz>`, `listing:<id>`* | 300s | 10m |
| `catalogue:index:v1:*`, `index-count` | `listPublicListingIndex`, `countPublicListings` (sitemaps, static params) | `sitemap` | 600s | 1h |
| `identity:trust:v1:<biz>` | `getTrustProfiles` | `seller:<biz>` | 120s | 10m |
| `identity:sellers:v1:*` | `listSellers` | `sellers`, `seller:<biz>`* | 120s | 10m |
| `identity:seller-index:v1:*` | `listSellerIndex` | `sitemap`, `sellers` | 600s | 1h |
| `search:q:v2:<sha1(normalised query, category, limit)>` | `searchListings` | `search`, `category:<slug>`, `listing:<id>`*, `seller:<biz>`* | 120s | 10m |
| `search:suggest:v2:*` | `suggest` | `search`, `categories` | 300s | 30m |
| `reviews:rating:v1:<listing>` | `getRatingSummary(ies)` (approved only) | `rating:<listing>` | 300s | 15m |
| `reviews:list:v1:<listing>:<sort>:<offset>:<n>` | `listApprovedReviews` | `reviews:<listing>`, `reviews:all` | 60s | 5m |
| `reviews:comments:v1:<listing>:<n>` | `listApprovedComments` | `reviews:<listing>`, `reviews:all` | 60s | 5m |
| `billing:plans:v1` | `listPlans` | `plans` | 600s | 1h |

`*` per-result tags are computed from the loaded value.

Next data cache (web tier): same tags; revalidate 120s (rails, sellers) / 300s (listing, seller, hits, ratings) / 900s (categories, keywords); pages: `revalidate` 300s (600s landing, 900s categories).

## 3. Invalidation map

Write paths invalidate Redis **after commit** (never inside the transaction, which would let a reader re-cache pre-commit data). The cache worker is the durable, cross-process backstop and the only path to the web tier.

| Event / write | Redis (hard unless noted) | Web tier (`/api/revalidate`) |
|---|---|---|
| `ListingPublished` | soft `featured`, `search`; hard `listing:<id>`, `seller-listings:<biz>`, `sitemap` on the write path | soft `listing:<id>`, `seller-listings:<biz>`, `featured`, `search`, `sitemap` |
| `ListingModerated`, `ListingArchived`, `ListingImageModerated` (+ update / image edit / reorder / delete write paths) | hard `listing:<id>`, `seller-listings:<biz>`, `sitemap`; soft `featured`, `search` | **hard** `listing:<id>`, `seller-listings:<biz>`, `featured`, `search`; soft `sitemap` |
| `ReviewModerated`, `CommentModerated` (+ edit of an approved review, report auto-flag, seller reply) | `rating:<listing>`, `reviews:<listing>` | hard `reviews:<listing>`, `rating:<listing>` |
| `TrustScoreChanged`, `BusinessVerified`, `BusinessCreated` (seller) | `seller:<biz>`, `sellers`, `sitemap` | soft `seller:<biz>`, `sellers`, `sitemap` |
| `DataErasureRequested` | `reviews:all` | hard `reviews:all` |
| `upsertCategories` | `categories`, `category:<slug>`, `sitemap` | (TTL; call `/api/revalidate` with `categories` after seeding) |
| `seedPlans` | `plans` | TTL |

## 4. SEO

- URLs: products `/p/<slug>-<uuid>` (slug self-heals with a 308), categories `/c/<slug>`. `/products/<id>` and `/categories/<slug>` permanently redirect (308). Manufacturers stay `/manufacturers/<uuid>`.
- Metadata everywhere: title template, description, canonical, OpenGraph, Twitter, robots; `en-IN` alternate map in the root layout (hreflang-ready: add locales there).
- JSON-LD: Organization + WebSite/SearchAction (home), Product + Offer (INR) + AggregateRating (approved reviews only, omitted at 0) + Review + BreadcrumbList (product), ItemList (category, landing, search, manufacturers), Organization/LocalBusiness (manufacturer).
- `sitemap.xml` (index, route handler) -> `/sitemaps/sitemap/<id>.xml`: id 0 = pages + categories + landing pages, then manufacturers and products in chunks of 10k, with `lastmod`.
- `robots.txt`: disallows private areas and `/api/`; AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, ...) are explicitly allowed. `/search?q=` is **not** disallowed so its `noindex,follow` is honoured.
- Dynamic OG images for the site and every product.
- AI: `/llms.txt` and `/llms-full.txt` (site facts, key pages, URL patterns, categories, featured products with prices, top suppliers, link to `API_PUBLIC_URL/docs` and `/openapi.json`). Product facts exist in a visible `<table>` and in JSON-LD; nothing is client-only.

## 5. Accessibility (WCAG 2.2 AA)

Contrast tokens were corrected in `packages/ui` (muted `#596272`, success `#15803d`, warning `#b45309`, danger `#b91c1c`, new `accent-700/800` for white-on-accent buttons and accent text; `accent-500` is decorative only). Skip link + `main` focus target, landmarks, global visible focus ring, focus-not-obscured scroll margin, keyboard-accessible popovers (Esc returns focus, focus-out closes), mobile menu dialog with focus trap and focus return, ARIA tabs for home rails, `Field` wires `aria-describedby` / `aria-invalid` / `role=alert`, label-in-name for the account and pincode buttons, heading hierarchy (sr-only `h2` before grids), `aria-live` on result counts and review lists, decorative images `alt=""` and product images with `alt`, targets >= 24px (44px on the primary mobile controls), reduced-motion. `apps/web/test/seo-a11y.test.tsx` renders key components with `react-dom/server` and also guards that cache-critical files never import cookies/headers/session/`searchParams`.

## 6. Operations

Env: `REVALIDATE_SECRET` (web + worker), `APP_URL` (canonical origin, also used by the worker if `WEB_REVALIDATE_URL` is unset), `API_PUBLIC_URL` (llms.txt links), optional `CACHE_LOG=1`, `CACHE_STATS_LOG=0`.
Worker: register `cacheWorker` from `@cnote/search` in `apps/worker/src/index.ts`.
