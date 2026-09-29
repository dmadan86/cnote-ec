// OpenSearch request builders (pure). Hybrid = BM25 request + kNN request, fused client-side (see fusion.ts).
import type { SearchIndexQuery } from "./types";

export const PRICE_RANGES = [
  { key: "under-1k", to: 100_000 },
  { key: "1k-10k", from: 100_000, to: 1_000_000 },
  { key: "10k-1l", from: 1_000_000, to: 10_000_000 },
  { key: "above-1l", from: 10_000_000 },
] as const;

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

const filters = (q: SearchIndexQuery) => (q.categoryId ? [{ term: { categoryId: q.categoryId } }] : []);
const SOURCE = ["listingId", "sellerBusinessId"];

export function buildLexicalRequest(q: SearchIndexQuery, opts: { facets?: boolean } = {}) {
  const from = decodeCursor(q.cursor);
  return {
    size: q.limit,
    from,
    _source: SOURCE,
    query: {
      bool: {
        filter: filters(q),
        must: [
          {
            multi_match: {
              query: q.text,
              type: "best_fields",
              fields: ["title^3", "categoryName^1.5", "description"],
              fuzziness: "AUTO",
              prefix_length: 1,
              minimum_should_match: "2<70%",
            },
          },
        ],
        should: [{ match: { "title.shingles": { query: q.text, boost: 2 } } }],
      },
    },
    ...(opts.facets ? { aggs: buildAggs() } : {}),
  };
}

export function buildKnnRequest(q: SearchIndexQuery) {
  if (!q.embedding) return null;
  return {
    size: q.limit,
    from: decodeCursor(q.cursor),
    _source: SOURCE,
    query: { knn: { embedding: { vector: q.embedding, k: Math.max(q.limit + decodeCursor(q.cursor), q.limit), ...(q.categoryId ? { filter: { term: { categoryId: q.categoryId } } } : {}) } } },
  };
}

export function buildAggs() {
  return {
    category: { terms: { field: "categorySlug", size: 20 } },
    city: { terms: { field: "city", size: 20 } },
    verificationTier: { terms: { field: "verificationTier", size: 5 } },
    price: { range: { field: "pricePaise", ranges: PRICE_RANGES.map((r) => ({ key: r.key, ...("from" in r ? { from: r.from } : {}), ...("to" in r ? { to: r.to } : {}) })) } },
  };
}

export function buildSuggestRequest(prefix: string, limit: number) {
  return { size: limit, _source: ["title"], query: { match: { "title.edge": { query: prefix, operator: "and" } } } };
}
