// OpenSearch request builders (pure). Hybrid = BM25 request + kNN request, fused client-side (see fusion.ts).
import { MAX_TIER, MAX_VARIANT_FACET_BUCKETS, PRICE_RANGES, type FacetDimension, type IndexFilters } from "../filters";
import type { SearchIndexQuery } from "./types";

export { PRICE_RANGES };

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}
export function decodeCursor(c: string | null | undefined): number {
  if (!c) return 0;
  try {
    const o = (JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { o?: unknown }).o;
    return typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= 10_000 ? o : 0;
  } catch {
    return 0;
  }
}

/** Legacy `categoryId`: always a hard filter inside the query (cheap, and keeps the request shape callers know). */
const filters = (q: SearchIndexQuery) => (q.categoryId ? [{ term: { categoryId: q.categoryId } }] : []);

const DIM_CLAUSES: Record<FacetDimension, (f: IndexFilters) => object[]> = {
  category: (f) => (f.categoryIds ? [{ terms: { categoryId: f.categoryIds } }] : []),
  tier: (f) => (f.minTier ? [{ terms: { verificationTier: Array.from({ length: MAX_TIER - f.minTier! + 1 }, (_, i) => String(f.minTier! + i)) } }] : []),
  state: (f) => (f.states ? [{ terms: { state: f.states } }] : []),
  city: (f) => (f.cities ? [{ terms: { city: f.cities } }] : []),
  variant: (f) => Object.entries(f.variantOptions ?? {}).map(([axis, values]) => ({ terms: { variantValues: values.map((v) => `${axis}:${v}`) } })),
  price: (f) => [
    ...(f.hasPrice ? [{ exists: { field: "pricePaise" } }] : []),
    ...(f.priceMinPaise !== undefined || f.priceMaxPaise !== undefined
      ? [{ range: { pricePaise: { ...(f.priceMinPaise !== undefined ? { gte: f.priceMinPaise } : {}), ...(f.priceMaxPaise !== undefined ? { lte: f.priceMaxPaise } : {}) } } }]
      : []),
  ],
};
/** "In stock only" is a plain filter, not a facet dimension, so it is never skipped. */
const stockClause = (f: IndexFilters): object[] => (f.inStockOnly ? [{ term: { availability: "in_stock" } }] : []);
/** MOQ is not a facet, so it never gets skipped: a listing with no stated MOQ qualifies for any "at most N" limit. */
const moqClause = (f: IndexFilters): object[] =>
  f.maxMoq !== undefined ? [{ bool: { should: [{ range: { moq: { lte: f.maxMoq } } }, { bool: { must_not: [{ exists: { field: "moq" } }] } }], minimum_should_match: 1 } }] : [];

/** Filter clauses for the given filters, leaving out one facet dimension when `skip` is set. */
export function filterClauses(f: IndexFilters | undefined, skip?: FacetDimension): object[] {
  if (!f) return [];
  return [...(Object.keys(DIM_CLAUSES) as FacetDimension[]).filter((d) => d !== skip).flatMap((d) => DIM_CLAUSES[d](f)), ...moqClause(f), ...stockClause(f)];
}

const asFilter = (clauses: object[]) => (clauses.length === 1 ? clauses[0]! : { bool: { filter: clauses } });
const SOURCE = ["listingId", "sellerBusinessId"];

const LEXICAL_FIELDS = ["title^3", "categoryName^1.5", "description"];
const multiMatch = (query: string, extra: object = {}) => ({
  multi_match: { query, type: "best_fields", fields: LEXICAL_FIELDS, fuzziness: "AUTO", prefix_length: 1, minimum_should_match: "2<70%", ...extra },
});
/** Transliteration/lexicon variants count for less than what the buyer typed. */
export const VARIANT_BOOST = 0.6;

export function buildLexicalRequest(q: SearchIndexQuery, opts: { facets?: boolean } = {}) {
  const from = decodeCursor(q.cursor);
  const variants = q.variants ?? [];
  const main = multiMatch(q.text);
  return {
    size: q.limit,
    from,
    _source: SOURCE,
    query: {
      bool: {
        filter: filters(q),
        // with variants the original OR any variant must match; without them the request shape is unchanged
        must: [variants.length ? { bool: { should: [main, ...variants.map((v) => multiMatch(v, { boost: VARIANT_BOOST }))], minimum_should_match: 1 } } : main],
        should: [{ match: { "title.shingles": { query: q.text, boost: 2 } } }, ...variants.map((v) => ({ match: { "title.shingles": { query: v, boost: 2 * VARIANT_BOOST } } }))],
      },
    },
    // Hits are narrowed AFTER aggregation (post_filter) so facet counts can leave out their own dimension.
    ...(filterClauses(q.filters).length ? { post_filter: { bool: { filter: filterClauses(q.filters) } } } : {}),
    ...(opts.facets ? { aggs: buildAggs(q.filters) } : {}),
  };
}

export function buildKnnRequest(q: SearchIndexQuery) {
  if (!q.embedding) return null;
  const clauses = [...filters(q), ...filterClauses(q.filters)];
  return {
    size: q.limit,
    from: decodeCursor(q.cursor),
    _source: SOURCE,
    query: { knn: { embedding: { vector: q.embedding, k: Math.max(q.limit + decodeCursor(q.cursor), q.limit), ...(clauses.length ? { filter: asFilter(clauses) } : {}) } } },
  };
}

/**
 * Disjunctive aggregations: each facet is a filter-aggregation holding every OTHER dimension's filter (see computeFacets for
 * the in-process equivalent). Without active filters the wrapper is omitted and the plain aggregation is used.
 */
export function buildAggs(f?: IndexFilters) {
  const wrap = (dim: FacetDimension, inner: object) => {
    const clauses = filterClauses(f, dim);
    return clauses.length ? { filter: { bool: { filter: clauses } }, aggs: { v: inner } } : inner;
  };
  return {
    category: wrap("category", { terms: { field: "categorySlug", size: 20 } }),
    city: wrap("city", { terms: { field: "city", size: 20 } }),
    state: wrap("state", { terms: { field: "state", size: 40 } }),
    verificationTier: wrap("tier", { terms: { field: "verificationTier", size: 5 } }),
    variant: wrap("variant", { terms: { field: "variantValues", size: MAX_VARIANT_FACET_BUCKETS } }),
    price: wrap("price", { range: { field: "pricePaise", ranges: PRICE_RANGES.map((r) => ({ key: r.key, ...("from" in r ? { from: r.from } : {}), ...("to" in r ? { to: r.to } : {}) })) } }),
  };
}

export function buildSuggestRequest(prefix: string, limit: number) {
  return { size: limit, _source: ["title"], query: { match: { "title.edge": { query: prefix, operator: "and" } } } };
}
