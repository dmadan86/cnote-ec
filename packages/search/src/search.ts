import { createHash } from "node:crypto";
import * as ai from "@cnote/ai";
import { getCategoryBySlug, getPublicListingsByIds } from "@cnote/catalogue";
import { cachedTagged, cacheTags } from "@cnote/core";
import { getTrustProfiles } from "@cnote/identity";
import { z } from "zod";
import { fusionWeights, INDIC_LEXICAL_WEIGHT, locationBoost, rrfFuse, toCandidates, trustFactor } from "./fusion";
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
});

interface Page {
  hits: SearchHit[];
  nextCursor: string | null;
  facets?: SearchFacets;
}

type SearchOpts = { q: string; categorySlug?: string; limit?: number; cursor?: string };
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
  const { q, categorySlug, limit, cursor } = optsSchema.parse(opts);
  const nq = normaliseQuery(q);
  const translit = translitEnabled();
  const key = `search:q:v5:${createHash("sha1").update(JSON.stringify([getSearchIndex().backend, nq, categorySlug ?? null, limit, cursor ?? null, translit, semanticBlend(), latinBlend(), indicLexicalWeight()])).digest("hex")}`;
  // Cached per NORMALISED query (so "boxes for cosmetics in India" and "boxes cosmetics" share one entry): 2 min fresh +
  // 10 min stale-while-revalidate. Entries are tagged with every listing/seller they contain, so a moderation/archive/trust
  // event purges exactly the results that show it (hard); new publications refresh the `search` tag softly.
  // tookMs always reflects this call.
  const page = await cachedTagged(
    key,
    (v: Page) => [cacheTags.search, ...(categorySlug ? [cacheTags.category(categorySlug)] : []), ...v.hits.flatMap((h) => [cacheTags.listing(h.listing.id), cacheTags.seller(h.seller.businessId)])],
    120,
    () => run(nq, categorySlug, limit, cursor, translit),
    { staleSeconds: 600, softTags: [cacheTags.search] },
  );
  return { hits: page.hits, tookMs: Date.now() - started, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.facets ? { facets: page.facets } : {}) };
}

/** SEARCH_TRANSLIT=off is a kill switch (and the eval baseline): cross-script variants are skipped, everything else is identical. */
export const translitEnabled = () => process.env.SEARCH_TRANSLIT !== "off";

async function run(nq: ReturnType<typeof normaliseQuery>, categorySlug: string | undefined, limit: number, cursor: string | undefined, translit: boolean): Promise<Page> {
  const empty: Page = { hits: [], nextCursor: null };
  let categoryId: string | null = null;
  let categoryName = "";
  if (categorySlug) {
    const cat = await getCategoryBySlug(categorySlug);
    if (!cat) return empty;
    categoryId = cat.id;
    categoryName = cat.name;
  }
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
  const res = await getSearchIndex().search({ text, location: nq.location, embedding, categoryId, limit: Math.max(30, limit * 3), cursor, ...(variants.length ? { variants } : {}) });
  const cands = toCandidates(res.hits);
  if (!cands.length) return { hits: [], nextCursor: null, facets: res.facets };

  const fused = rrfFuse(cands, undefined, ...fusionWeights(text, translit, indicLexicalWeight()));
  const profiles = await getTrustProfiles([...new Set(cands.map((c) => c.sellerBusinessId))]);
  const scored = cands
    .flatMap((c) => {
      const seller = profiles.get(c.sellerBusinessId);
      const rel = fused.get(c.listingId) ?? 0;
      return seller && rel > 0 ? [{ id: c.listingId, seller, score: rel * trustFactor(seller) * locationBoost(seller.city, nq.location) }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const listings = new Map((await getPublicListingsByIds(scored.map((s) => s.id))).map((l) => [l.id, l]));
  const hits = scored.flatMap((s) => {
    const listing = listings.get(s.id);
    return listing ? [{ listing, seller: s.seller, score: Number(s.score.toFixed(5)), sponsored: false as const }] : [];
  });
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
