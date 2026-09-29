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

export async function searchListings(opts: { q: string; categorySlug?: string; limit?: number }): Promise<{ hits: SearchHit[]; tookMs: number }> {
  void opts;
  throw new Error("not implemented");
}

/** Query suggestions for the search box ("Try asking" chips + typeahead). */
export async function suggest(prefix: string, limit = 8): Promise<string[]> {
  void prefix; void limit;
  throw new Error("not implemented");
}
