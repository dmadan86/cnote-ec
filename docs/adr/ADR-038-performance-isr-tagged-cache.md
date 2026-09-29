# ADR-038: Performance: static/ISR, tag revalidation and Redis tagged caching

**Status:** Accepted
**Note:** Detail: `docs/design/performance-and-seo.md`.

**Context.** Founder directive: fast like Amazon, cache aggressively, SEO and AI-crawler friendly, WCAG 2.2 AA. Reading cookies in shared layouts made every page dynamic.

**Options.**
1. Enable Next `cacheComponents` (PPR). Large refactor, build errors on any dynamic read while many pages are changing.
2. Classic ISR with static shells and per-user client islands, plus tag-based on-demand revalidation and a Redis cache tier.
3. Full SSR with a CDN cache in front. Fragile invalidation.

**Decision.** Option 2. Public pages are static or ISR (`revalidate`, `generateStaticParams`); the shell is static and per-user state (saved, compare, reviews-my-review, header actions) is a client island fed by one `GET /api/me` (`private, no-store`, `Vary: Cookie`). Nothing personal appears in cacheable HTML. Two cache tiers: Next data/page cache with tags, and Redis tagged caching for search and catalogue reads (`cache-worker` invalidates by tag on domain events). Publish, moderation and price events purge affected tags and CDN URLs through `POST /api/revalidate` guarded by `REVALIDATE_SECRET`. Private areas send `no-store` and `noindex`. Search and listings get short `s-maxage` with stale-while-revalidate.

**Rationale.**
- Static HTML from the CDN for the common path; sub-100 ms TTFB target on cached pages.
- Invalidation is explicit and event-driven, so freshness bugs are traceable.
- `llms.txt`, sitemaps and structured data are served statically.

**Consequences.**
- Tag maps must be maintained; a missed tag serves stale content until TTL.
- Client islands add a request per page load and layout shift risk.
- CSP nonces (ADR-037) need a static-friendly strategy (hash-based or per-route).

**Review.** Revisit `cacheComponents` when page edits by other teams settle. Track cache hit ratio and p95 TTFB per route; alert on drops.
