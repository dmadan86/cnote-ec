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

export { cacheWorker, cacheHandlers } from "./cache-worker";
