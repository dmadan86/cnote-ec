// @cnote/search — hybrid lexical + semantic search, trust-weighted ranking (ADR-009).
// Rank = relevance × trust; never by paid tier. Sponsored slots (none in Phase 1) must be labelled.
// PUBLIC CONTRACT. Extend, don't break.
import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";

export interface SearchHit {
  listing: ListingView;
  seller: TrustProfile;
  score: number;
  sponsored: false;
}

export { searchListings } from "./search";
export { suggest, EXAMPLE_QUERIES } from "./suggest";
export { normaliseQuery, type NormalisedQuery } from "./normalise";
export { expandQuery, romanVariants, toRoman, fromRoman, colloquial, detectScript, hasIndic, type IndicScript } from "./translit";
export { ndcgAtK, reciprocalRank, evaluateRun, type Judgement, type EvalSummary } from "./eval/metrics";

export { cacheWorker, cacheHandlers } from "./cache-worker";

// Swappable index backend (postgres | opensearch by SEARCH_BACKEND) and its indexer worker.
export { getSearchIndex, searchBackendName, OpenSearchIndex, postgresIndex } from "./index-port";
export type { SearchIndex, SearchIndexQuery, SearchIndexResult, IndexDoc, RawHit, SearchFacets, FacetBucket, PriceBucket, IndexHealth, ReindexResult, SearchBackendName } from "./index-port";
export { searchIndexer, indexerHandlers, syncListings, reindexAll } from "./indexer";
