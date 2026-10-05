// Search filters, facets and sort as PURE functions (ADR-009). Both index backends and the web layer share these, so the
// meaning of a filter, a facet count and a sort order is identical on Postgres and OpenSearch.
//
// Trust rule (ADR-000/009): organic order is a function of relevance, trust, price and recency ONLY. `sortOrganic`'s input
// type has no plan / ad-spend field, and the property test in test/filters.props.test.ts proves that attaching one never
// changes any order.
import { z } from "zod";

/** Highest verification tier (T0..T3, ADR-003). */
export const MAX_TIER = 3;

export const SORTS = ["relevance", "price_asc", "price_desc", "newest", "trust"] as const;
export type SearchSort = (typeof SORTS)[number];
export const isSearchSort = (v: unknown): v is SearchSort => typeof v === "string" && (SORTS as readonly string[]).includes(v);

/** Price buckets for the facet (paise). Shared with the OpenSearch range aggregation. */
export const PRICE_RANGES = [
  { key: "under-1k", to: 100_000 },
  { key: "1k-10k", from: 100_000, to: 1_000_000 },
  { key: "10k-1l", from: 1_000_000, to: 10_000_000 },
  { key: "above-1l", from: 10_000_000 },
] as const;

const MAX_LIST = 10;
export const MAX_VARIANT_AXES_FILTER = 6;
const slugList = z.array(z.string().trim().min(1).max(100)).max(MAX_LIST);
const place = z.array(z.string().trim().min(1).max(80)).max(MAX_LIST);
const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** What a caller (web, API, search-service) may ask for. Everything is optional; absent = no constraint. */
export const filtersSchema = z.object({
  /** Category slugs. Each one also matches its subcategories. */
  categories: slugList.optional(),
  /** Minimum seller verification tier, 0..3 (0 = any). */
  minTier: z.number().int().min(0).max(MAX_TIER).optional(),
  /** Seller state(s), case-insensitive. */
  states: place.optional(),
  /** Seller city/cities, case-insensitive. */
  cities: place.optional(),
  priceMinPaise: paise.optional(),
  priceMaxPaise: paise.optional(),
  /** "I can accept at most N units MOQ": listings with no stated MOQ always qualify. */
  maxMoq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  /** Exclude "price on request" listings. */
  hasPrice: z.boolean().optional(),
  /** Only listings that are in stock today (made-to-order does not count). A filter, never a ranking signal. */
  inStockOnly: z.boolean().optional(),
  /** Variant axis -> chosen values (e.g. { size: ["M", "L"], colour: ["red"] }): OR within an axis, AND across axes; case-insensitive. */
  variantOptions: z.record(z.string().trim().min(1).max(30), z.array(z.string().trim().min(1).max(60)).max(20)).refine((r) => Object.keys(r).length <= MAX_VARIANT_AXES_FILTER).optional(),
});
export type SearchFilters = z.infer<typeof filtersSchema>;

/** Filters after category slugs were resolved to ids (with descendants) and places lower-cased. Index backends see only this. */
export interface IndexFilters {
  categoryIds?: string[];
  minTier?: number;
  states?: string[];
  cities?: string[];
  priceMinPaise?: number;
  priceMaxPaise?: number;
  maxMoq?: number;
  hasPrice?: boolean;
  inStockOnly?: boolean;
  /** axis -> lower-cased values */
  variantOptions?: Record<string, string[]>;
}

const uniq = (xs: string[] | undefined, lower: boolean): string[] | undefined => {
  const out = [...new Set((xs ?? []).map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter(Boolean))].sort();
  return out.length ? out : undefined;
};

/** Canonical form: empty/neutral values dropped, lists sorted and de-duplicated. Stable, so it is safe in a cache key. */
export function normaliseFilters(f: SearchFilters | undefined): SearchFilters {
  if (!f) return {};
  const min = f.priceMinPaise;
  let max = f.priceMaxPaise;
  if (min !== undefined && max !== undefined && max < min) max = undefined; // contradictory range: keep the lower bound only
  const out: SearchFilters = {};
  const categories = uniq(f.categories, false);
  const states = uniq(f.states, true);
  const cities = uniq(f.cities, true);
  if (categories) out.categories = categories;
  if (f.minTier && f.minTier > 0) out.minTier = Math.min(MAX_TIER, f.minTier);
  if (states) out.states = states;
  if (cities) out.cities = cities;
  if (min !== undefined && min > 0) out.priceMinPaise = min;
  if (max !== undefined) out.priceMaxPaise = max;
  if (f.maxMoq !== undefined) out.maxMoq = f.maxMoq;
  if (f.hasPrice) out.hasPrice = true;
  if (f.inStockOnly) out.inStockOnly = true;
  const variantOptions: Record<string, string[]> = {};
  for (const axis of Object.keys(f.variantOptions ?? {}).map((a) => a.trim().toLowerCase()).filter(Boolean).sort()) {
    const values = uniq(Object.entries(f.variantOptions ?? {}).filter(([k]) => k.trim().toLowerCase() === axis).flatMap(([, v]) => v), true);
    if (values) variantOptions[axis] = values;
  }
  if (Object.keys(variantOptions).length) out.variantOptions = variantOptions;
  return out;
}

export const hasActiveFilters = (f: SearchFilters | IndexFilters | undefined): boolean => !!f && Object.keys(f).length > 0;

/** The facts about a listing + its seller that filters and facets look at. */
export interface FilterRow {
  categoryId: string;
  categorySlug?: string;
  tier: number | null;
  state: string | null;
  city: string | null;
  pricePaise: number | null;
  moq: number | null;
  /** effective availability is in_stock */
  inStock?: boolean;
  /** lower-cased "axis:value" pairs of the listing's variants */
  variantValues?: string[];
}

export type FacetDimension = "category" | "tier" | "state" | "city" | "price" | "variant";

const lc = (s: string | null) => (s ?? "").trim().toLowerCase();

/** Does the row satisfy every filter, optionally ignoring one facet dimension (for disjunctive facet counts)? */
export function matchesFilters(row: FilterRow, f: IndexFilters, skip?: FacetDimension): boolean {
  if (skip !== "category" && f.categoryIds && !f.categoryIds.includes(row.categoryId)) return false;
  if (skip !== "tier" && f.minTier && (row.tier ?? 0) < f.minTier) return false;
  if (skip !== "state" && f.states && !f.states.includes(lc(row.state))) return false;
  if (skip !== "city" && f.cities && !f.cities.includes(lc(row.city))) return false;
  if (skip !== "price") {
    const p = row.pricePaise;
    if (f.hasPrice && p == null) return false;
    if (f.priceMinPaise !== undefined && (p == null || p < f.priceMinPaise)) return false;
    if (f.priceMaxPaise !== undefined && (p == null || p > f.priceMaxPaise)) return false;
  }
  if (f.maxMoq !== undefined && row.moq != null && row.moq > f.maxMoq) return false;
  if (f.inStockOnly && !row.inStock) return false;
  if (skip !== "variant" && f.variantOptions) {
    const have = new Set(row.variantValues ?? []);
    for (const [axis, values] of Object.entries(f.variantOptions)) if (!values.some((v) => have.has(`${axis}:${v}`))) return false;
  }
  return true;
}

export interface FacetBucketLite {
  key: string;
  count: number;
}
export interface PriceBucketLite extends FacetBucketLite {
  fromPaise: number | null;
  toPaise: number | null;
}
export interface FacetCounts {
  category: FacetBucketLite[];
  city: FacetBucketLite[];
  state: FacetBucketLite[];
  verificationTier: FacetBucketLite[];
  price: PriceBucketLite[];
  /** keys are lower-cased "axis:value" pairs; counts ignore the variant filters themselves (see computeFacets) */
  variant: FacetBucketLite[];
}

export function priceBucketKey(paise: number): string {
  for (const r of PRICE_RANGES) {
    const from = "from" in r ? r.from : 0;
    const to = "to" in r ? r.to : Infinity;
    if (paise >= from && paise < to) return r.key;
  }
  return PRICE_RANGES[PRICE_RANGES.length - 1]!.key;
}

const byCount = (a: FacetBucketLite, b: FacetBucketLite) => b.count - a.count || a.key.localeCompare(b.key);

function tally(rows: FilterRow[], f: IndexFilters, dim: FacetDimension, keyOf: (r: FilterRow) => string | null): FacetBucketLite[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!matchesFilters(r, f, dim)) continue;
    const k = keyOf(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([key, count]) => ({ key, count })).sort(byCount);
}

export const MAX_VARIANT_FACET_BUCKETS = 60;

/** Lower-cased, sorted "axis:value" keys of a listing's variants (the same keys the live row stores in `variant_values`). */
export function variantKeysOf(variants: readonly { axisValues: Record<string, string> }[] | undefined): string[] {
  const set = new Set<string>();
  for (const v of variants ?? []) for (const [k, val] of Object.entries(v.axisValues)) set.add(`${k}:${val}`.toLowerCase());
  return [...set].sort();
}

function tallyMany(rows: FilterRow[], f: IndexFilters, dim: FacetDimension, keysOf: (r: FilterRow) => string[]): FacetBucketLite[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!matchesFilters(r, f, dim)) continue;
    for (const k of new Set(keysOf(r))) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([key, count]) => ({ key, count })).sort(byCount);
}

/**
 * Disjunctive ("multi-select") facet counts: each dimension is counted with every OTHER filter applied but not its own, so
 * selecting a tier still shows what the other tiers would give. Used by the Postgres backend over its match pool; the
 * OpenSearch adapter reaches the same numbers with filter aggregations (see index-port/query.ts).
 */
export function computeFacets(rows: FilterRow[], f: IndexFilters): FacetCounts {
  const priceCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.pricePaise == null || !matchesFilters(r, f, "price")) continue;
    const k = priceBucketKey(r.pricePaise);
    priceCounts.set(k, (priceCounts.get(k) ?? 0) + 1);
  }
  return {
    category: tally(rows, f, "category", (r) => r.categorySlug ?? null),
    city: tally(rows, f, "city", (r) => lc(r.city) || null),
    state: tally(rows, f, "state", (r) => lc(r.state) || null),
    verificationTier: tally(rows, f, "tier", (r) => String(Math.min(MAX_TIER, Math.max(0, r.tier ?? 0)))).sort((a, b) => Number(b.key) - Number(a.key)),
    variant: tallyMany(rows, f, "variant", (r) => r.variantValues ?? []).slice(0, MAX_VARIANT_FACET_BUCKETS),
    price: PRICE_RANGES.map((r) => ({ key: r.key, fromPaise: "from" in r ? r.from : null, toPaise: "to" in r ? r.to : null, count: priceCounts.get(r.key) ?? 0 })),
  };
}

// ---- sorting ---------------------------------------------------------------------------------------

/**
 * Everything an organic sort may look at. There is deliberately NO plan, tier-of-subscription or ad-spend field here:
 * paid status cannot reach the comparator (ADR-009/024). `tier` is the VERIFICATION tier (ADR-003), earned not bought.
 */
export interface OrganicItem {
  id: string;
  /** relevance x trust x location boost (the default "relevance" order) */
  score: number;
  pricePaise: number | null;
  /** first-published time, ms since epoch */
  publishedAtMs: number;
  /** verification tier 0..3 */
  tier: number;
  trustScore: number;
}

type Cmp = (a: OrganicItem, b: OrganicItem) => number;
const byScore: Cmp = (a, b) => b.score - a.score;
const byId: Cmp = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// "price on request" sorts last in both price directions: it has no price to compare
const price = (dir: 1 | -1): Cmp => (a, b) => {
  if (a.pricePaise == null || b.pricePaise == null) return a.pricePaise == null ? (b.pricePaise == null ? 0 : 1) : -1;
  return dir * (a.pricePaise - b.pricePaise);
};
const chain = (...cmps: Cmp[]): Cmp => (a, b) => {
  for (const c of cmps) {
    const r = c(a, b);
    if (r) return r;
  }
  return 0;
};

const COMPARATORS: Record<SearchSort, Cmp> = {
  relevance: chain(byScore, byId),
  price_asc: chain(price(1), byScore, byId),
  price_desc: chain(price(-1), byScore, byId),
  newest: chain((a, b) => b.publishedAtMs - a.publishedAtMs, byScore, byId),
  trust: chain((a, b) => b.tier - a.tier, (a, b) => b.trustScore - a.trustScore, byScore, byId),
};

/** Total, deterministic order (ties end on the listing id), independent of the input order. Returns a new array. */
export function sortOrganic<T extends OrganicItem>(items: readonly T[], sort: SearchSort = "relevance"): T[] {
  return [...items].sort(COMPARATORS[sort] ?? COMPARATORS.relevance);
}
