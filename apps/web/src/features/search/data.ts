import "server-only";
import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import {
  countPublicListings, getCategoryBySlug, getPublicListing, listCategories, listFeaturedListings, listPublicListingIndex, listPublicSellerListings,
  type CategoryView, type ListingIndexEntry, type ListingView,
} from "@cnote/catalogue";
import { cacheTags } from "@cnote/core";
import { getTrustProfiles, listSellerIndex, listSellers, type TrustProfile } from "@cnote/identity";
import { getRatingSummaries, listApprovedComments, listApprovedReviews, listPublicQuestions, type Page, type PublicComment, type PublicReview, type QaPage, type ReviewSort } from "@cnote/reviews";
import { hasActiveFilters, searchListings, suggest, type SearchFacets, type SearchFilters, type SearchHit, type SearchSort } from "@cnote/search";

/**
 * Buyer-site read layer. Two cache tiers sit under every public page:
 *   1. Redis (inside each @cnote module: shared across instances, tag-invalidated, SWR, stampede-safe)
 *   2. Next.js data cache (`unstable_cache` here: feeds ISR pages; tags mirror the Redis tags and are purged by
 *      POST /api/revalidate, driven by domain events through the cache worker).
 * Only PUBLIC, non-personalised data may flow through here. Per-user state lives in /api/me + client islands.
 * (`unstable_cache` rather than `use cache`: see docs/design/performance-and-seo.md for why Cache Components is not enabled.)
 */

/** Runs a loader and returns `fallback` on any failure so pages render even if a module is down. Failures are never cached. */
export async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[web] ${label} failed:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

const REVALIDATE = { short: 120, normal: 300, long: 900 } as const;

function nextCached<T>(parts: string[], tags: string[], revalidate: number, fn: () => Promise<T>): Promise<T> {
  return unstable_cache(fn, ["web", ...parts], { tags, revalidate })();
}

const digest = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export const isPublic = (l: ListingView) => l.status === "published" && l.moderationStatus === "approved";

export const loadCategories = () =>
  safe("catalogue.listCategories", () => nextCached(["categories"], [cacheTags.categories], REVALIDATE.long, async () => (await listCategories()).filter((c) => !c.prohibited)), [] as CategoryView[]);

export const loadCategory = (slug: string) =>
  safe("catalogue.getCategoryBySlug", () => nextCached(["category", slug], [cacheTags.categories, cacheTags.category(slug)], REVALIDATE.long, () => getCategoryBySlug(slug)), null);

/** Public (published + approved) listing or null. Unapproved content is never cached at either tier. */
export const loadListing = (id: string) =>
  safe("catalogue.getPublicListing", () => nextCached(["listing", id], [cacheTags.listing(id)], REVALIDATE.normal, () => getPublicListing(id)), null);

export const loadSellers = (opts: { q?: string; city?: string; limit?: number; offset?: number }) =>
  safe("identity.listSellers", () => nextCached(["sellers", digest(opts)], [cacheTags.sellers], REVALIDATE.short, () => listSellers(opts)), [] as TrustProfile[]);

export const loadSuggestions = (fallback: string[]) =>
  safe("search.suggest", () => nextCached(["suggest"], [cacheTags.search], REVALIDATE.long, async () => {
    const s = await suggest("", 6);
    return s.length ? s : fallback;
  }), fallback);

export async function loadSeller(id: string): Promise<TrustProfile | null> {
  return safe("identity.getTrustProfiles", () => nextCached(["seller", id], [cacheTags.seller(id)], REVALIDATE.normal, async () => (await getTrustProfiles([id])).get(id) ?? null), null);
}

export async function loadSellerListings(id: string): Promise<ListingView[]> {
  return safe("catalogue.listPublicSellerListings", () => nextCached(["seller-listings", id], [cacheTags.sellerListings(id), cacheTags.seller(id)], REVALIDATE.normal, () => listPublicSellerListings(id)), [] as ListingView[]);
}

export async function loadFeatured(sort: "popular" | "new", limit: number): Promise<ListingView[]> {
  return safe("catalogue.listFeaturedListings", () => nextCached(["featured", sort, String(limit)], [cacheTags.featured], REVALIDATE.short, () => listFeaturedListings({ sort, limit })), [] as ListingView[]);
}

type HitsOpts = { q: string; categorySlug?: string; limit: number; filters?: SearchFilters; sort?: SearchSort };
export type HitsResult = { hits: SearchHit[]; failed: boolean; facets?: SearchFacets };

/**
 * Search hits (+ facet counts when the backend gives them) with a fallback to featured listings when the search module cannot
 * serve a plain browse. The fallback never runs when filters are active: it would ignore them and show listings the buyer excluded.
 */
export async function loadHits(opts: HitsOpts): Promise<HitsResult> {
  const { categories: selected = [], ...others } = opts.filters ?? {};
  const filtered = hasActiveFilters(others); // category alone still gets the featured fallback below
  const categorySlugs = [...new Set([...selected, ...(opts.categorySlug ? [opts.categorySlug] : [])])];
  try {
    const { hits, facets } = await searchListings(opts);
    if (hits.length || opts.q || filtered) return { hits, failed: false, ...(facets ? { facets } : {}) };
  } catch (err) {
    console.error("[web] search.searchListings failed:", err instanceof Error ? err.message : err);
    if (opts.q || filtered) return { hits: [], failed: true };
  }
  // Empty query (category / browse pages): fall back to published listings filtered by category.
  const featured = await loadFeatured("new", 50);
  const pool = featured.filter((l) => !categorySlugs.length || categorySlugs.includes(l.category.slug)).slice(0, opts.limit);
  const sellers = await safe("identity.getTrustProfiles", () => getTrustProfiles([...new Set(pool.map((l) => l.sellerBusinessId))]), new Map<string, TrustProfile>());
  const hits: SearchHit[] = pool.flatMap((listing) => {
    const seller = sellers.get(listing.sellerBusinessId);
    return seller ? [{ listing, seller, score: 0, sponsored: false as const }] : [];
  });
  return { hits, failed: false };
}

/** `loadHits` for ISR pages (category, landing, similar products): Next-cached, purged on `search` / `category:<slug>` / listing tags. */
export async function loadHitsStatic(opts: HitsOpts, extraTags: string[] = []): Promise<HitsResult> {
  try {
    return await nextCached(["hits", digest(opts)], [cacheTags.search, cacheTags.featured, ...(opts.categorySlug ? [cacheTags.category(opts.categorySlug)] : []), ...extraTags], REVALIDATE.normal, async () => {
      const r = await loadHits(opts);
      if (r.failed) throw new Error("search unavailable"); // never cache a degraded result
      return r;
    });
  } catch {
    return { hits: [], failed: true };
  }
}

export interface RatingLite {
  average: number;
  count: number;
}

/** Approved-review rating summaries for a page of cards, batch-loaded (one Redis MGET, one DB query on misses). */
export async function loadRatings(listingIds: string[]): Promise<Record<string, RatingLite>> {
  const ids = [...new Set(listingIds)].sort();
  if (!ids.length) return {};
  return safe(
    "reviews.getRatingSummaries",
    () =>
      nextCached(["ratings", digest(ids)], ids.map((id) => cacheTags.rating(id)), REVALIDATE.normal, async () => {
        const m = await getRatingSummaries(ids);
        return Object.fromEntries([...m].map(([id, s]) => [id, { average: s.average, count: s.count }]));
      }),
    {} as Record<string, RatingLite>,
  );
}

export async function loadRatingSummary(listingId: string) {
  return safe(
    "reviews.getRatingSummary",
    () => nextCached(["rating-summary", listingId], [cacheTags.rating(listingId)], REVALIDATE.normal, async () => (await getRatingSummaries([listingId])).get(listingId) ?? null),
    null,
  );
}

export async function loadReviewsPage(listingId: string, sort: ReviewSort = "recent", cursor?: string | null): Promise<Page<PublicReview>> {
  return safe(
    "reviews.listApprovedReviews",
    () => nextCached(["reviews", listingId, sort, cursor ?? ""], [cacheTags.reviews(listingId), cacheTags.reviewsAll], REVALIDATE.short, () => listApprovedReviews(listingId, { sort, cursor })),
    { items: [], nextCursor: null } as Page<PublicReview>,
  );
}

export async function loadComments(listingId: string): Promise<PublicComment[]> {
  return safe(
    "reviews.listApprovedComments",
    () => nextCached(["comments", listingId], [cacheTags.reviews(listingId), cacheTags.reviewsAll], REVALIDATE.short, () => listApprovedComments(listingId)),
    [] as PublicComment[],
  );
}

/** First page of a listing's public answered Q&A (approved question + approved answer only). Purged by `qa:<id>` (answer, moderation, erasure). */
export async function loadQaPage(listingId: string): Promise<QaPage> {
  return safe(
    "reviews.listPublicQuestions",
    () => nextCached(["qa", listingId], [cacheTags.qa(listingId), cacheTags.qaAll], REVALIDATE.short, () => listPublicQuestions(listingId)),
    { items: [], nextCursor: null, total: 0 } as QaPage,
  );
}

// ---- sitemap / static params ----------------------------------------------------------------------
export const loadListingIndex = (offset: number, limit: number) => safe("catalogue.listPublicListingIndex", () => listPublicListingIndex({ offset, limit }), [] as ListingIndexEntry[]);
export const loadListingCount = () => safe("catalogue.countPublicListings", () => countPublicListings(), 0);
export const loadSellerIndex = (offset: number, limit: number) => safe("identity.listSellerIndex", () => listSellerIndex({ offset, limit }), [] as { businessId: string; createdAt: string }[]);

// ---- curated SEO landing pages (/s/<category>/<keyword>) ---------------------------------------------
const STOP = new Set(["the", "and", "for", "with", "of", "in", "a", "an", "to", "new", "best", "buy"]);

/** Two-word head phrase of a listing title ("Kraft corrugated box 3 ply" -> "kraft corrugated"), or null when too thin. */
function headPhrase(title: string): string | null {
  const words = (title.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  if (!words.length) return null;
  return words.slice(0, 2).join(" ");
}

/**
 * Keyword phrases per category derived from live listing titles. This is the allow-list of indexable search
 * landing pages: arbitrary /s/<cat>/<anything> URLs 404 instead of becoming thin, spammable index entries.
 */
export async function loadLandingKeywords(): Promise<Record<string, string[]>> {
  return safe(
    "catalogue.landingKeywords",
    () =>
      nextCached(["landing-keywords"], [cacheTags.sitemap, cacheTags.featured], REVALIDATE.long, async () => {
        const rows = await listPublicListingIndex({ offset: 0, limit: 2000 });
        const by = new Map<string, Map<string, number>>();
        for (const r of rows) {
          const p = headPhrase(r.title);
          if (!p) continue;
          const m = by.get(r.categorySlug) ?? new Map<string, number>();
          m.set(p, (m.get(p) ?? 0) + 1);
          by.set(r.categorySlug, m);
        }
        return Object.fromEntries([...by].map(([cat, m]) => [cat, [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p]) => p)]));
      }),
    {} as Record<string, string[]>,
  );
}
