// SearchIndex port (ADR-009). Callers depend on this interface only; the backend (Postgres | OpenSearch) is chosen by
// SEARCH_BACKEND. Ranking (RRF + trust factor) is NOT part of the port: adapters return raw per-list scores and
// searchListings fuses them with the same code on every backend, so ordering stays identical.
import type { IndexFilters } from "../filters";
import type { NormalisedQuery } from "../normalise";

export interface SearchIndexQuery extends NormalisedQuery {
  embedding?: number[];
  /** Extra lexical-only query strings (transliteration / cross-script lexicon). Never used for the embedding. */
  variants?: string[];
  /** Legacy single-category filter (kept for callers that predate `filters`). */
  categoryId?: string | null;
  /** Resolved filters (ids, lower-cased places). Hard filters on hits; facet counts are disjunctive (see computeFacets). */
  filters?: IndexFilters;
  limit: number;
  /** Opaque cursor from a previous result's nextCursor (OpenSearch only; Postgres ignores it). */
  cursor?: string | null;
}

export interface RawHit {
  listingId: string;
  sellerBusinessId: string;
  /** BM25 / ts_rank_cd score; 0 = no lexical match. Only its order is used. */
  lexicalScore: number;
  /** Cosine similarity in 0..1; 0 = absent from the vector list. */
  vectorScore: number;
}

export interface FacetBucket {
  key: string;
  count: number;
}
export interface PriceBucket {
  key: string;
  fromPaise: number | null;
  toPaise: number | null;
  count: number;
}
export interface SearchFacets {
  category: FacetBucket[];
  city: FacetBucket[];
  state: FacetBucket[];
  verificationTier: FacetBucket[];
  price: PriceBucket[];
  /** keys are lower-cased "axis:value" pairs of listing variants (docs/design/variants-stock.md) */
  variant: FacetBucket[];
}

export interface SearchIndexResult {
  hits: RawHit[];
  nextCursor: string | null;
  /** First page only. Postgres computes them from the lexical match pool (capped), OpenSearch from aggregations. */
  facets?: SearchFacets;
}

/** The public projection of a listing joined with its seller's trust profile: everything ranking/filtering needs. */
export interface IndexDoc {
  listingId: string;
  sellerBusinessId: string;
  categoryId: string;
  categorySlug: string;
  categoryName: string;
  title: string;
  description: string;
  city: string | null;
  state: string | null;
  verificationTier: number;
  trustScore: number;
  badgeActive: boolean;
  pricePaise: number | null;
  moq: number | null;
  /** effective availability: in_stock | made_to_order | out_of_stock. A filter ("in stock only"), never a ranking input. */
  availability?: string;
  /** lower-cased "axis:value" pairs of the listing's variants */
  variantValues?: string[];
  embedding?: number[];
  updatedAt: string;
  /** External version (monotonic, ms). Defaults to the time the doc was built. Stale writes are ignored. */
  version?: number;
}

export interface IndexHealth {
  ok: boolean;
  backend: SearchBackendName;
  detail: string;
}

export interface ReindexResult {
  indexed: number;
  failed: number;
  index: string | null;
}

export type SearchBackendName = "postgres" | "opensearch";

export interface SearchIndex {
  readonly backend: SearchBackendName;
  search(q: SearchIndexQuery): Promise<SearchIndexResult>;
  upsert(docs: IndexDoc[]): Promise<void>;
  remove(listingIds: string[]): Promise<void>;
  health(): Promise<IndexHealth>;
  /** Rebuild the whole index from a stream of doc batches (zero downtime on OpenSearch; no-op drain on Postgres). */
  reindexAll(stream: AsyncIterable<IndexDoc[]>): Promise<ReindexResult>;
}
