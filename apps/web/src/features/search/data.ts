import "server-only";
import { getCategoryBySlug, getListing, listCategories, listFeaturedListings, listSellerListings, type CategoryView, type ListingView } from "@cnote/catalogue";
import { getTrustProfiles, listSellers, type TrustProfile } from "@cnote/identity";
import { searchListings, suggest, type SearchHit } from "@cnote/search";

/** Runs a loader and returns `fallback` on any failure so pages render even if a module is down. */
export async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[web] ${label} failed:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

export const isPublic = (l: ListingView) => l.status === "published" && l.moderationStatus === "approved";

export const loadCategories = () => safe("catalogue.listCategories", async () => (await listCategories()).filter((c) => !c.prohibited), [] as CategoryView[]);
export const loadCategory = (slug: string) => safe("catalogue.getCategoryBySlug", () => getCategoryBySlug(slug), null);
export const loadListing = (id: string) => safe("catalogue.getListing", () => getListing(id), null);
export const loadSellers = (opts: { q?: string; city?: string; limit?: number; offset?: number }) => safe("identity.listSellers", () => listSellers(opts), [] as TrustProfile[]);
export const loadSuggestions = (fallback: string[]) =>
  safe("search.suggest", async () => {
    const s = await suggest("", 6);
    return s.length ? s : fallback;
  }, fallback);

export async function loadSeller(id: string): Promise<TrustProfile | null> {
  return safe("identity.getTrustProfiles", async () => (await getTrustProfiles([id])).get(id) ?? null, null);
}

export async function loadSellerListings(id: string): Promise<ListingView[]> {
  return safe("catalogue.listSellerListings", async () => (await listSellerListings(id)).filter(isPublic), [] as ListingView[]);
}

export async function loadFeatured(sort: "popular" | "new", limit: number): Promise<ListingView[]> {
  return safe("catalogue.listFeaturedListings", () => listFeaturedListings({ sort, limit }), [] as ListingView[]);
}

/** Search hits with a fallback to featured listings when the search module cannot serve the query. */
export async function loadHits(opts: { q: string; categorySlug?: string; limit: number }): Promise<{ hits: SearchHit[]; failed: boolean }> {
  try {
    const { hits } = await searchListings(opts);
    if (hits.length || opts.q) return { hits, failed: false };
  } catch (err) {
    console.error("[web] search.searchListings failed:", err instanceof Error ? err.message : err);
    if (opts.q) return { hits: [], failed: true };
  }
  // Empty query (category / browse pages): fall back to published listings filtered by category.
  const featured = await loadFeatured("new", 200);
  const filtered = featured.filter((l) => !opts.categorySlug || l.category.slug === opts.categorySlug).slice(0, opts.limit);
  const sellers = await safe("identity.getTrustProfiles", () => getTrustProfiles([...new Set(filtered.map((l) => l.sellerBusinessId))]), new Map<string, TrustProfile>());
  const hits: SearchHit[] = filtered.flatMap((listing) => {
    const seller = sellers.get(listing.sellerBusinessId);
    return seller ? [{ listing, seller, score: 0, sponsored: false as const }] : [];
  });
  return { hits, failed: false };
}
