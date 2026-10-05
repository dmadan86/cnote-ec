import { createHash } from "node:crypto";
import * as ai from "@cnote/ai";
import { getCategoryBySlug, getPublicListingsByIds, listCategories } from "@cnote/catalogue";
import { cachedTagged, cacheTags } from "@cnote/core";
import { getTrustProfiles } from "@cnote/identity";
import { z } from "zod";
import { filtersSchema, hasActiveFilters, isSearchSort, matchesFilters, normaliseFilters, sortOrganic, variantKeysOf, type IndexFilters, type OrganicItem, type SearchFilters, type SearchSort } from "./filters";
import { fusionWeights, INDIC_LEXICAL_WEIGHT, organicScore, rrfFuse, toCandidates } from "./fusion";
import { getSearchIndex, type SearchFacets } from "./index-port";
import { normaliseQuery } from "./normalise";
import { blendVectors, ORIGINAL_BLEND, planSemantic } from "./semantic";
import { expandQuery } from "./translit/variants";
import { remoteSearch, searchFallbackEnabled, searchTransport, sharedSearchServiceClient } from "./remote";
import type { SearchHit } from "./index";

const optsSchema = z.object({
  q: z.string().max(500),
  categorySlug: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
  /** Buyer filters (tier, place, price, MOQ, categories); see filters.ts. */
  filters: filtersSchema.optional(),
  /** Organic sort. `relevance` (default) = relevance x trust. No sort is ever influenced by plan or ad spend. */
  sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "trust"]).default("relevance"),
});

interface Page {
  hits: SearchHit[];
  nextCursor: string | null;
  facets?: SearchFacets;
}

type SearchOpts = { q: string; categorySlug?: string; limit?: number; cursor?: string; filters?: SearchFilters; sort?: SearchSort };
type SearchResult = { hits: SearchHit[]; tookMs: number; nextCursor?: string | null; facets?: SearchFacets };

/**
 * Entry point. SEARCH_TRANSPORT=http routes to apps/search-service (breaker + in-process fallback, ADR-018 pattern);
 * the default runs in-process. The service itself always runs in-process.
 */
export async function searchListings(opts: SearchOpts): Promise<SearchResult> {
  if (searchTransport() === "http") return remoteSearch(sharedSearchServiceClient(), opts, searchFallbackEnabled() ? () => searchListingsLocal(opts) : null);
  return searchListingsLocal(opts);
}

/** `cursor`, `nextCursor` and `facets` are additive and only populated by backends that support them (OpenSearch). */
export async function searchListingsLocal(opts: SearchOpts): Promise<SearchResult> {
  const started = Date.now();
  const parsed = optsSchema.parse(opts);
  const { q, limit, cursor } = parsed;
  const sort = isSearchSort(parsed.sort) ? parsed.sort : "relevance";
  // the legacy single `categorySlug` is just one selected category
  const filters = normaliseFilters({ ...parsed.filters, categories: [...(parsed.filters?.categories ?? []), ...(parsed.categorySlug ? [parsed.categorySlug] : [])] });
  const categorySlug = parsed.categorySlug ?? filters.categories?.[0];
  const nq = normaliseQuery(q);
  const translit = translitEnabled();
  const key = `search:q:v6:${createHash("sha1").update(JSON.stringify([getSearchIndex().backend, nq, filters, sort, limit, cursor ?? null, translit, semanticBlend(), latinBlend(), indicLexicalWeight()])).digest("hex")}`;
  // Cached per NORMALISED query (so "boxes for cosmetics in India" and "boxes cosmetics" share one entry): 2 min fresh +
  // 10 min stale-while-revalidate. Entries are tagged with every listing/seller they contain, so a moderation/archive/trust
  // event purges exactly the results that show it (hard); new publications refresh the `search` tag softly.
  // tookMs always reflects this call.
  const page = await cachedTagged(
    key,
    (v: Page) => [cacheTags.search, ...(filters.categories ?? []).map((c) => cacheTags.category(c)), ...v.hits.flatMap((h) => [cacheTags.listing(h.listing.id), cacheTags.seller(h.seller.businessId)])],
    120,
    () => run(nq, filters, sort, limit, cursor, translit),
    { staleSeconds: 600, softTags: [cacheTags.search] },
  );
  return { hits: page.hits, tookMs: Date.now() - started, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.facets ? { facets: page.facets } : {}) };
}

/** SEARCH_TRANSLIT=off is a kill switch (and the eval baseline): cross-script variants are skipped, everything else is identical. */
export const translitEnabled = () => process.env.SEARCH_TRANSLIT !== "off";

/** Selected category slugs -> ids including every descendant (a parent matches its subcategories). Unknown slugs are dropped. */
async function resolveCategories(slugs: string[]): Promise<{ ids: string[]; name: string } | null> {
  const first = await getCategoryBySlug(slugs[0]!);
  const all = slugs.length > 1 || first ? await listCategories() : [];
  const ids = new Set<string>();
  let name = first?.name ?? "";
  for (const slug of slugs) {
    const root = slug === slugs[0] ? (first ?? all.find((c) => c.slug === slug)) : all.find((c) => c.slug === slug);
    if (!root) continue;
    if (!name) name = root.name;
    ids.add(root.id);
    // breadth-first over parentId links; `seen` guards against a malformed cycle
    for (let frontier = [root.id]; frontier.length; ) {
      const next = all.filter((c) => c.parentId && frontier.includes(c.parentId) && !ids.has(c.id)).map((c) => c.id);
      next.forEach((id) => ids.add(id));
      frontier = next;
    }
  }
  return ids.size ? { ids: [...ids].sort(), name } : null;
}

async function run(nq: ReturnType<typeof normaliseQuery>, filters: SearchFilters, sort: SearchSort, limit: number, cursor: string | undefined, translit: boolean): Promise<Page> {
  const empty: Page = { hits: [], nextCursor: null };
  const index: IndexFilters = {};
  let categoryName = "";
  if (filters.categories?.length) {
    const cats = await resolveCategories(filters.categories);
    if (!cats) return empty;
    index.categoryIds = cats.ids;
    categoryName = cats.name;
  }
  if (filters.minTier) index.minTier = filters.minTier;
  if (filters.states) index.states = filters.states;
  if (filters.cities) index.cities = filters.cities;
  if (filters.priceMinPaise !== undefined) index.priceMinPaise = filters.priceMinPaise;
  if (filters.priceMaxPaise !== undefined) index.priceMaxPaise = filters.priceMaxPaise;
  if (filters.maxMoq !== undefined) index.maxMoq = filters.maxMoq;
  if (filters.hasPrice) index.hasPrice = true;
  if (filters.inStockOnly) index.inStockOnly = true;
  if (filters.variantOptions) index.variantOptions = filters.variantOptions;
  const text = nq.text || categoryName; // pure category browse falls back to the category's own text
  if (!text) return empty;

  // Cross-script recall (ADR-004): transliteration + lexicon variants join the lexical query; for Indic/mixed-script queries
  // the best Latin variant also drives the embedding (the hashing embedder only understands Latin), see semantic.ts.
  const variants = translit ? expandQuery(text) : [];
  let embedding: number[] | undefined;
  try {
    const plan = planSemantic(text, variants, semanticBlend(), latinBlend());
    const { vectors } = await ai.embed(plan.texts);
    embedding = plan.texts.length === 1 ? vectors[0] : blendVectors(vectors, plan.weights);
  } catch {
    embedding = undefined; // embedding outage degrades to lexical-only rather than failing search
  }
  // A non-relevance sort orders the whole candidate pool, so it needs a wider pool than the page to be meaningful.
  const pool = sort === "relevance" ? Math.max(30, limit * 3) : Math.max(120, limit * 5);
  const res = await getSearchIndex().search({ text, location: nq.location, embedding, ...(hasActiveFilters(index) ? { filters: index } : {}), limit: Math.min(200, pool), cursor, ...(variants.length ? { variants } : {}) });
  const cands = toCandidates(res.hits);
  if (!cands.length) return { hits: [], nextCursor: null, facets: res.facets };

  const fused = rrfFuse(cands, undefined, ...fusionWeights(text, translit, indicLexicalWeight()));
  const profiles = await getTrustProfiles([...new Set(cands.map((c) => c.sellerBusinessId))]);
  const scored = cands.flatMap((c) => {
    const seller = profiles.get(c.sellerBusinessId);
    const rel = fused.get(c.listingId) ?? 0;
    return seller && rel > 0 ? [{ id: c.listingId, seller, score: organicScore(rel, seller, nq.location) }] : [];
  });

  // Relevance order is decided before hydration (cheap). Other sorts need listing facts (price, publish date), so hydrate the
  // whole pool first. Either way the order comes from sortOrganic: relevance, trust, price and recency only, never plan/ads.
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const { categoryIds: _scope, ...recheck } = index; // category scope is enforced by the index; the rest can go stale
  const wanted = sort === "relevance" && !hasActiveFilters(recheck) ? ranked.slice(0, limit) : ranked;
  const listings = new Map((await getPublicListingsByIds(wanted.map((s) => s.id))).map((l) => [l.id, l]));
  const items = wanted.flatMap((s) => {
    const listing = listings.get(s.id);
    if (!listing) return [];
    // Backstop for stale index data (OpenSearch docs lag the live row): re-check the filters against the live listing and the
    // seller profile. A no-op when the index already filtered correctly.
    if (hasActiveFilters(recheck) && !matchesFilters({ categoryId: "", tier: s.seller.verificationTier, state: s.seller.state, city: s.seller.city, pricePaise: listing.pricePaise ?? null, moq: listing.moq ?? null, inStock: (listing.availability ?? "in_stock") === "in_stock", variantValues: variantKeysOf(listing.variants) }, recheck)) return [];
    const item: OrganicItem & { listing: typeof listing; seller: typeof s.seller } = {
      id: s.id,
      score: s.score,
      pricePaise: listing.pricePaise ?? null,
      publishedAtMs: Date.parse(listing.createdAt) || 0,
      tier: s.seller.verificationTier ?? 0,
      trustScore: s.seller.trustScore ?? 0,
      listing,
      seller: s.seller,
    };
    return [item];
  });
  const hits = sortOrganic(items, sort)
    .slice(0, limit)
    .map((it) => ({ listing: it.listing, seller: it.seller, score: Number(it.score.toFixed(5)), sponsored: false as const }));
  return { hits, nextCursor: res.nextCursor, facets: res.facets };
}

/** SEARCH_SEMANTIC_BLEND: weight (0..1) of the ORIGINAL query embedding blended with its Latin variant; default 0, variant only; eval-tuned. */
export function semanticBlend(): number {
  const n = Number(process.env.SEARCH_SEMANTIC_BLEND);
  return process.env.SEARCH_SEMANTIC_BLEND !== undefined && process.env.SEARCH_SEMANTIC_BLEND !== "" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : ORIGINAL_BLEND;
}

/** SEARCH_LATIN_BLEND: weight (0..1) of the lexicon-canonicalised variant blended into Latin (English/Hinglish) query embeddings; default 0. */
export function latinBlend(): number {
  const n = Number(process.env.SEARCH_LATIN_BLEND);
  return Number.isFinite(n) && process.env.SEARCH_LATIN_BLEND ? Math.min(1, Math.max(0, n)) : 0;
}

/** SEARCH_INDIC_LEX_WEIGHT: RRF weight of the lexical list for Indic/mixed-script queries (vector list stays 1); default 0.4, eval-tuned. */
export function indicLexicalWeight(): number {
  const n = Number(process.env.SEARCH_INDIC_LEX_WEIGHT);
  return process.env.SEARCH_INDIC_LEX_WEIGHT && Number.isFinite(n) && n > 0 ? Math.min(5, n) : INDIC_LEXICAL_WEIGHT;
}
