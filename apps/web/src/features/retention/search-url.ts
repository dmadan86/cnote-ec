// Saved search <-> /search URL. Pure (no server-only / client-only imports). The URL is the source of truth for a search, so a saved
// search stores the same SearchFilters the page hands to searchListings, and "View results" rebuilds the same URL from them.
import type { SearchFilters, SearchSort } from "@cnote/search";
import { EMPTY_FILTERS, hrefFor, isSort, type FilterState } from "@/features/search/filter-state";

/** Inverse of toSearchArgs (the "deliver to" pincode was already folded into `states` when the search was saved). */
export function filtersToState(filters: SearchFilters | Record<string, unknown> | undefined, sort: string | undefined): FilterState {
  const f = (filters ?? {}) as SearchFilters;
  return {
    ...EMPTY_FILTERS,
    tier: f.minTier ?? 0,
    states: f.states ?? [],
    cities: f.cities ?? [],
    categories: f.categories ?? [],
    pmin: f.priceMinPaise !== undefined ? Math.round(f.priceMinPaise / 100) : null,
    pmax: f.priceMaxPaise !== undefined ? Math.round(f.priceMaxPaise / 100) : null,
    moq: f.maxMoq ?? null,
    priced: f.hasPrice === true,
    sort: sort && isSort(sort) ? (sort as SearchSort) : "relevance",
  };
}

/** App-relative /search URL that re-runs a saved search. */
export function savedSearchHref(s: { query: string; filters: Record<string, unknown>; sort: string }): string {
  return hrefFor("/search", { q: s.query || undefined }, filtersToState(s.filters, s.sort));
}

/** Parses the hidden `filters` field of the save form; anything that is not a plain object means "no filters". */
export function parseFiltersField(raw: unknown): SearchFilters {
  if (typeof raw !== "string" || raw.length > 4000) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SearchFilters) : {};
  } catch {
    return {};
  }
}
