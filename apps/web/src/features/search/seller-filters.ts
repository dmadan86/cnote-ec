// Manufacturers tab: tier / state / city filters, facet counts and sort over trust profiles. Same pure functions as the
// product search (@cnote/search), so a filter means the same thing on both tabs. Paid plan is not a field of TrustProfile.
import { computeFacets, matchesFilters, type FacetCounts, type FilterRow, type IndexFilters } from "@cnote/search";
import type { TrustProfile } from "@cnote/identity";
import { toSearchArgs, type FilterState } from "./filter-state";

const row = (p: TrustProfile): FilterRow => ({ categoryId: "", tier: p.verificationTier, state: p.state, city: p.city, pricePaise: null, moq: null });

/** Only the seller-level dimensions; price, MOQ and category do not apply to a supplier. */
function sellerFilters(s: FilterState): IndexFilters {
  const f = toSearchArgs(s).filters;
  return { ...(f.minTier ? { minTier: f.minTier } : {}), ...(f.states ? { states: f.states } : {}), ...(f.cities ? { cities: f.cities } : {}) };
}

export function filterSellers(profiles: TrustProfile[], s: FilterState): TrustProfile[] {
  const f = sellerFilters(s);
  return profiles.filter((p) => matchesFilters(row(p), f));
}

export function sellerFacets(profiles: TrustProfile[], s: FilterState): Pick<FacetCounts, "verificationTier" | "state" | "city"> {
  const { verificationTier, state, city } = computeFacets(profiles.map(row), sellerFilters(s));
  return { verificationTier, state, city };
}

/** `relevance` keeps the module's own order (verified badge, then trust score). `trust` is tier first, then trust score. */
export function sortSellers(profiles: TrustProfile[], sort: FilterState["sort"]): TrustProfile[] {
  if (sort !== "trust") return profiles;
  return [...profiles].sort((a, b) => b.verificationTier - a.verificationTier || b.trustScore - a.trustScore || a.name.localeCompare(b.name) || (a.businessId < b.businessId ? -1 : 1));
}
